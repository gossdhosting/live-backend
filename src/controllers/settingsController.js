import Settings from '../models/Settings.js';
import logger from '../utils/logger.js';
import EmailService from '../services/EmailService.js';
import PushoverService from '../services/PushoverService.js';
import S3Service from '../services/S3Service.js';

// Get all settings
export const getAllSettings = async (req, res) => {
  try {
    const settings = await Settings.getAll();
    // Ensure we're sending clean JSON without any database connection objects
    res.json({ settings: JSON.parse(JSON.stringify(settings)) });
  } catch (error) {
    logger.error('Get all settings error', { error: error.message });
    res.status(500).json({ error: 'Internal server error' });
  }
};

// Update settings
export const updateSettings = async (req, res) => {
  try {
    const { settings } = req.body;

    logger.info('Update settings called', { settingsKeys: Object.keys(settings || {}), settingsCount: Object.keys(settings || {}).length });
    console.log('[Settings] Received update request:', JSON.stringify(settings, null, 2));

    if (!settings || typeof settings !== 'object') {
      logger.warn('Invalid settings format received');
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

    logger.info('Calling Settings.updateMultiple...');
    const updatedSettings = await Settings.updateMultiple(settings);
    logger.info('Settings.updateMultiple completed', { updatedCount: updatedSettings ? updatedSettings.length : 0 });

    // Reset email transporter if SMTP settings changed
    if (settings.smtp_host || settings.smtp_port || settings.smtp_user || settings.smtp_password || settings.smtp_secure || settings.smtp_from_email || settings.smtp_from_name) {
      EmailService.resetTransporter();
      logger.info('Email transporter reset due to SMTP settings change');
    }

    // Reinitialize S3 if AWS settings changed
    if (settings.aws_access_key_id || settings.aws_secret_access_key || settings.aws_region || settings.s3_bucket_name) {
      await S3Service.initialize();
      logger.info('S3Service reinitialized due to AWS settings change');
    }

    logger.info('Settings updated successfully', { settingsCount: Object.keys(settings).length });
    console.log('[Settings] Update successful, returning:', updatedSettings?.length || 0, 'settings');

    // Ensure we're sending clean JSON without any database connection objects
    res.json({ settings: JSON.parse(JSON.stringify(updatedSettings)) });
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

// Test AWS S3 connection
export const testS3Connection = async (req, res) => {
  try {
    // Temporarily set the credentials from request if provided (for testing before saving)
    const { aws_access_key_id, aws_secret_access_key, aws_region, s3_bucket_name } = req.body;

    if (aws_access_key_id && aws_secret_access_key && s3_bucket_name) {
      // Temporarily save to test
      await Settings.set('aws_access_key_id', aws_access_key_id);
      await Settings.set('aws_secret_access_key', aws_secret_access_key);
      await Settings.set('aws_region', aws_region || 'us-east-1');
      await Settings.set('s3_bucket_name', s3_bucket_name);
      await S3Service.initialize();
    }

    const result = await S3Service.testConnection();

    if (result.success) {
      logger.info('S3 connection test successful', { bucket: result.bucket, region: result.region });
      res.json({
        success: true,
        message: `Successfully connected to S3 bucket: ${result.bucket} in region ${result.region}`,
        bucket: result.bucket,
        region: result.region,
      });
    } else {
      logger.error('S3 connection test failed', { error: result.message });
      res.status(500).json({
        success: false,
        error: result.message || 'Failed to connect to S3',
      });
    }
  } catch (error) {
    logger.error('S3 test error', { error: error.message });
    res.status(500).json({
      success: false,
      error: error.message || 'Failed to test S3 connection',
    });
  }
};
