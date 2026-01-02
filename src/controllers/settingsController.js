import Settings from '../models/Settings.js';
import logger from '../utils/logger.js';

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

    logger.info('Settings updated', { settings });

    res.json({ settings: updatedSettings });
  } catch (error) {
    logger.error('Update settings error', { error: error.message });
    res.status(500).json({ error: 'Internal server error' });
  }
};
