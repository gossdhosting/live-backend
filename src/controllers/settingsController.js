import Settings from '../models/Settings.js';
import logger from '../utils/logger.js';
import EmailService from '../services/EmailService.js';
import PushoverService from '../services/PushoverService.js';

// Get all settings
export const getAllSettings = (req, res) => {
  try {
    const settings = Settings.getAll();
    res.json({ settings });
  } catch (error) {
    logger.error('Get all settings error', { error: error.message });
    res.status(500).json({ error: 'Internal server error' });
  }
};

// Update settings
export const updateSettings = (req, res) => {
  try {
    const { settings } = req.body;

    if (!settings || typeof settings !== 'object') {
      return res.status(400).json({ error: 'Invalid settings format' });
    }

    // Validate specific settings
    if (settings.max_concurrent_streams) {
      const maxStreams = parseInt(settings.max_concurrent_streams);
      if (isNaN(maxStreams) || maxStreams < 1 || maxStreams > 100) {
        return res
          .status(400)
          .json({ error: 'max_concurrent_streams must be between 1 and 100' });
      }
    }

    if (settings.hls_segment_duration) {
      const duration = parseInt(settings.hls_segment_duration);
      if (isNaN(duration) || duration < 1 || duration > 10) {
        return res
          .status(400)
          .json({ error: 'hls_segment_duration must be between 1 and 10' });
      }
    }

    if (settings.hls_list_size) {
      const size = parseInt(settings.hls_list_size);
      if (isNaN(size) || size < 3 || size > 20) {
        return res
          .status(400)
          .json({ error: 'hls_list_size must be between 3 and 20' });
      }
    }

    const updatedSettings = Settings.updateMultiple(settings);

    // Reset email transporter if SMTP settings changed
    if (settings.smtp_host || settings.smtp_port || settings.smtp_user || settings.smtp_password || settings.smtp_secure || settings.smtp_from_email || settings.smtp_from_name) {
      EmailService.resetTransporter();
    }

    logger.info('Settings updated', { settings });

    res.json({ settings: updatedSettings });
  } catch (error) {
    logger.error('Update settings error', { error: error.message });
    res.status(500).json({ error: 'Internal server error' });
  }
};

// Test Pushover notification
export const testPushover = async (req, res) => {
  try {
    const result = await PushoverService.testNotification();

    if (result.success) {
      logger.info('Pushover test notification sent successfully');
      res.json({ message: 'Test notification sent successfully! Check your Pushover app.' });
    } else {
      logger.error('Pushover test failed', { error: result.message });
      res.status(500).json({ error: result.message || 'Failed to send notification' });
    }
  } catch (error) {
    logger.error('Pushover test error', { error: error.message });
    res.status(500).json({ error: error.message || 'Failed to send notification' });
  }
};
