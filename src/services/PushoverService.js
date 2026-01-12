import https from 'https';
import querystring from 'querystring';
import Settings from '../models/Settings.js';
import logger from '../utils/logger.js';

class PushoverService {
  // Send push notification via Pushover
  static async sendNotification(title, message, priority = 0) {
    try {
      const settings = await Settings.getAll();
      const settingsMap = {};
      settings.forEach(s => {
        settingsMap[s.key] = s.value;
      });

      const pushover_token = settingsMap.pushover_token;
      const pushover_user = settingsMap.pushover_user;
      const pushover_enabled = settingsMap.pushover_enabled === 'true';

      if (!pushover_enabled || !pushover_token || !pushover_user) {
        logger.debug('Pushover not configured or disabled');
        return { success: false, message: 'Pushover not configured' };
      }

      const postData = querystring.stringify({
        token: pushover_token,
        user: pushover_user,
        title: title,
        message: message,
        priority: priority,
      });

      return new Promise((resolve, reject) => {
        const options = {
          hostname: 'api.pushover.net',
          port: 443,
          path: '/1/messages.json',
          method: 'POST',
          headers: {
            'Content-Type': 'application/x-www-form-urlencoded',
            'Content-Length': Buffer.byteLength(postData),
          },
        };

        const req = https.request(options, (res) => {
          let data = '';

          res.on('data', (chunk) => {
            data += chunk;
          });

          res.on('end', () => {
            try {
              const response = JSON.parse(data);
              if (response.status === 1) {
                logger.info('Pushover notification sent', { title });
                resolve({ success: true });
              } else {
                logger.error('Pushover notification failed', { errors: response.errors });
                resolve({ success: false, message: response.errors?.join(', ') || 'Unknown error' });
              }
            } catch (error) {
              logger.error('Failed to parse Pushover response', { error: error.message });
              resolve({ success: false, message: 'Invalid response from Pushover' });
            }
          });
        });

        req.on('error', (error) => {
          logger.error('Pushover request error', { error: error.message });
          reject(error);
        });

        req.write(postData);
        req.end();
      });
    } catch (error) {
      logger.error('Pushover notification error', { error: error.message });
      return { success: false, message: error.message };
    }
  }

  // Notify about new user signup
  static async notifyNewSignup(user) {
    const message = `New user registered:\n${user.name} (${user.email})\nAuth: ${user.auth_provider || 'local'}\nPlan: ${user.plan_name || 'N/A'}`;
    return await this.sendNotification('New User Signup', message, 0);
  }

  // Test Pushover configuration
  static async testNotification() {
    const message = 'This is a test notification from RexStream. Your Pushover integration is working correctly!';
    return await this.sendNotification('RexStream Test Notification', message, 0);
  }
}

export default PushoverService;
