import https from 'https';
import logger from '../utils/logger.js';

const ONESIGNAL_APP_ID = process.env.ONESIGNAL_APP_ID || '67adb2c4-fadb-42d4-844e-3d672b68a199';
const ONESIGNAL_REST_API_KEY = process.env.ONESIGNAL_REST_API_KEY;

if (!ONESIGNAL_REST_API_KEY) {
  logger.error('ONESIGNAL_REST_API_KEY environment variable is required');
  throw new Error('ONESIGNAL_REST_API_KEY environment variable is required');
}

class OneSignalService {
  /**
   * Send push notification to specific user(s)
   * @param {string|string[]} playerIds - OneSignal player ID(s)
   * @param {string} title - Notification title
   * @param {string} message - Notification message
   * @param {object} data - Additional data to send with notification
   */
  static async sendNotification(playerIds, title, message, data = {}) {
    try {
      // Ensure playerIds is an array
      const ids = Array.isArray(playerIds) ? playerIds : [playerIds];

      // Filter out null/undefined IDs
      const validIds = ids.filter(id => id);

      if (validIds.length === 0) {
        logger.debug('No valid OneSignal player IDs provided');
        return { success: false, message: 'No valid player IDs' };
      }

      const payload = JSON.stringify({
        app_id: ONESIGNAL_APP_ID,
        include_player_ids: validIds,
        headings: { en: title },
        contents: { en: message },
        data: data,
      });

      return new Promise((resolve, reject) => {
        const options = {
          hostname: 'onesignal.com',
          port: 443,
          path: '/api/v1/notifications',
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Basic ${ONESIGNAL_REST_API_KEY}`,
            'Content-Length': Buffer.byteLength(payload),
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
              if (response.id) {
                logger.info('OneSignal notification sent', {
                  notificationId: response.id,
                  recipients: response.recipients
                });
                resolve({ success: true, notificationId: response.id });
              } else {
                logger.error('OneSignal notification failed', { errors: response.errors });
                resolve({
                  success: false,
                  message: response.errors?.join(', ') || 'Unknown error'
                });
              }
            } catch (error) {
              logger.error('Failed to parse OneSignal response', { error: error.message });
              resolve({ success: false, message: 'Invalid response from OneSignal' });
            }
          });
        });

        req.on('error', (error) => {
          logger.error('OneSignal request error', { error: error.message });
          reject(error);
        });

        req.write(payload);
        req.end();
      });
    } catch (error) {
      logger.error('OneSignal notification error', { error: error.message });
      return { success: false, message: error.message };
    }
  }

  /**
   * Notify user when stream starts successfully
   */
  static async notifyStreamStarted(playerIds, channelName) {
    return await this.sendNotification(
      playerIds,
      '🎥 Stream Started',
      `Your stream "${channelName}" is now live!`,
      { type: 'stream_started', channelName }
    );
  }

  /**
   * Notify user when stream stops
   */
  static async notifyStreamStopped(playerIds, channelName) {
    return await this.sendNotification(
      playerIds,
      '⏹️ Stream Stopped',
      `Your stream "${channelName}" has ended.`,
      { type: 'stream_stopped', channelName }
    );
  }

  /**
   * Notify user when stream encounters an error
   */
  static async notifyStreamError(playerIds, channelName, error) {
    return await this.sendNotification(
      playerIds,
      '❌ Stream Error',
      `Stream "${channelName}" encountered an error: ${error}`,
      { type: 'stream_error', channelName, error }
    );
  }

  /**
   * Notify user when scheduled stream is about to start
   */
  static async notifyScheduledStreamStarting(playerIds, channelName, minutesUntilStart) {
    return await this.sendNotification(
      playerIds,
      '⏰ Scheduled Stream Starting Soon',
      `Your scheduled stream "${channelName}" starts in ${minutesUntilStart} minutes.`,
      { type: 'scheduled_stream_starting', channelName, minutesUntilStart }
    );
  }

  /**
   * Notify user when platform connection succeeds
   */
  static async notifyPlatformConnected(playerIds, platform) {
    return await this.sendNotification(
      playerIds,
      '✅ Platform Connected',
      `Successfully connected to ${platform}!`,
      { type: 'platform_connected', platform }
    );
  }

  /**
   * Notify user when platform connection fails
   */
  static async notifyPlatformConnectionFailed(playerIds, platform, error) {
    return await this.sendNotification(
      playerIds,
      '⚠️ Platform Connection Failed',
      `Failed to connect to ${platform}: ${error}`,
      { type: 'platform_connection_failed', platform, error }
    );
  }

  /**
   * Notify user when subscription is renewed
   */
  static async notifySubscriptionRenewed(playerIds, planName) {
    return await this.sendNotification(
      playerIds,
      '💳 Subscription Renewed',
      `Your ${planName} subscription has been renewed successfully.`,
      { type: 'subscription_renewed', planName }
    );
  }

  /**
   * Notify user when subscription expires
   */
  static async notifySubscriptionExpired(playerIds, planName) {
    return await this.sendNotification(
      playerIds,
      '⚠️ Subscription Expired',
      `Your ${planName} subscription has expired. Renew to continue using premium features.`,
      { type: 'subscription_expired', planName }
    );
  }

  /**
   * Notify user when storage limit is reached
   */
  static async notifyStorageLimitReached(playerIds, usedStorage, totalStorage) {
    return await this.sendNotification(
      playerIds,
      '💾 Storage Limit Reached',
      `You've used ${usedStorage}MB of ${totalStorage}MB storage. Delete some media or upgrade your plan.`,
      { type: 'storage_limit_reached', usedStorage, totalStorage }
    );
  }

  /**
   * Notify admins about new support ticket
   */
  static async notifyNewTicket(playerIds, ticketNumber, subject, userName) {
    return await this.sendNotification(
      playerIds,
      '🎫 New Support Ticket',
      `${userName} created ticket #${ticketNumber}: ${subject}`,
      {
        type: 'new_ticket',
        ticket_number: ticketNumber,
        subject: subject,
        user_name: userName
      }
    );
  }

  /**
   * Notify user about ticket reply
   */
  static async notifyTicketReply(playerIds, ticketNumber, subject, replierName, isFromAdmin) {
    const title = isFromAdmin ? '💬 Support Replied to Your Ticket' : '💬 New Reply on Your Ticket';
    const message = isFromAdmin
      ? `Support replied to ticket #${ticketNumber}: ${subject}`
      : `${replierName} replied to ticket #${ticketNumber}: ${subject}`;

    return await this.sendNotification(
      playerIds,
      title,
      message,
      {
        type: 'ticket_reply',
        ticket_number: ticketNumber,
        subject: subject,
        replier_name: replierName
      }
    );
  }

  /**
   * Notify user about ticket status change
   */
  static async notifyTicketStatusChange(playerIds, ticketNumber, subject, newStatus) {
    const statusLabels = {
      open: 'Open',
      in_progress: 'In Progress',
      waiting_customer: 'Waiting for Your Response',
      resolved: 'Resolved',
      closed: 'Closed'
    };

    return await this.sendNotification(
      playerIds,
      '🔄 Ticket Status Updated',
      `Your ticket #${ticketNumber} status changed to ${statusLabels[newStatus] || newStatus}`,
      {
        type: 'ticket_status_changed',
        ticket_number: ticketNumber,
        subject: subject,
        new_status: newStatus
      }
    );
  }

  /**
   * Notify admin about ticket assignment
   */
  static async notifyTicketAssigned(playerIds, ticketNumber, subject, category) {
    return await this.sendNotification(
      playerIds,
      '📌 Ticket Assigned to You',
      `You've been assigned ticket #${ticketNumber}: ${subject}`,
      {
        type: 'ticket_assigned',
        ticket_number: ticketNumber,
        subject: subject,
        category: category
      }
    );
  }
}

export default OneSignalService;
