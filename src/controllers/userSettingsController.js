import UserSettings from '../models/UserSettings.js';
import logger from '../utils/logger.js';

// Get user's settings
export const getUserSettings = (req, res) => {
  try {
    const userId = req.user.id;
    const settings = UserSettings.getAllWithDefaults(userId);
    res.json({ settings });
  } catch (error) {
    logger.error('Get user settings error', { error: error.message, userId: req.user?.id });
    res.status(500).json({ error: 'Internal server error' });
  }
};

// Update user's settings
export const updateUserSettings = (req, res) => {
  try {
    const userId = req.user.id;
    const { settings } = req.body;

    if (!settings || typeof settings !== 'object') {
      return res.status(400).json({ error: 'Invalid settings format' });
    }

    // Validate title settings
    const allowedKeys = [
      'title_bg_color',
      'title_opacity',
      'title_position',
      'title_text_color',
      'title_font_size',
      'title_box_padding'
    ];

    // Filter to only allowed keys
    const filteredSettings = {};
    for (const [key, value] of Object.entries(settings)) {
      if (allowedKeys.includes(key)) {
        filteredSettings[key] = value;
      }
    }

    if (Object.keys(filteredSettings).length === 0) {
      return res.status(400).json({ error: 'No valid settings to update' });
    }

    // Validate specific settings
    if (filteredSettings.title_opacity) {
      const opacity = parseInt(filteredSettings.title_opacity);
      if (isNaN(opacity) || opacity < 0 || opacity > 100) {
        return res.status(400).json({ error: 'title_opacity must be between 0 and 100' });
      }
    }

    if (filteredSettings.title_font_size) {
      const fontSize = parseInt(filteredSettings.title_font_size);
      if (isNaN(fontSize) || fontSize < 16 || fontSize > 72) {
        return res.status(400).json({ error: 'title_font_size must be between 16 and 72' });
      }
    }

    if (filteredSettings.title_box_padding) {
      const padding = parseInt(filteredSettings.title_box_padding);
      if (isNaN(padding) || padding < 0 || padding > 20) {
        return res.status(400).json({ error: 'title_box_padding must be between 0 and 20' });
      }
    }

    if (filteredSettings.title_position) {
      const validPositions = ['top-left', 'top-center', 'top-right', 'bottom-left', 'bottom-center', 'bottom-right'];
      if (!validPositions.includes(filteredSettings.title_position)) {
        return res.status(400).json({ error: 'Invalid title_position value' });
      }
    }

    if (filteredSettings.title_bg_color) {
      const colorRegex = /^#[0-9A-F]{6}$/i;
      if (!colorRegex.test(filteredSettings.title_bg_color)) {
        return res.status(400).json({ error: 'Invalid title_bg_color format (use #RRGGBB)' });
      }
    }

    if (filteredSettings.title_text_color) {
      const colorRegex = /^#[0-9A-F]{6}$/i;
      if (!colorRegex.test(filteredSettings.title_text_color)) {
        return res.status(400).json({ error: 'Invalid title_text_color format (use #RRGGBB)' });
      }
    }

    const updatedSettings = UserSettings.updateMultiple(userId, filteredSettings);

    logger.info('User settings updated', { userId, settings: filteredSettings });

    res.json({ settings: updatedSettings });
  } catch (error) {
    logger.error('Update user settings error', { error: error.message, userId: req.user?.id });
    res.status(500).json({ error: 'Internal server error' });
  }
};

// Reset user settings to defaults
export const resetUserSettings = (req, res) => {
  try {
    const userId = req.user.id;

    UserSettings.deleteAll(userId);

    logger.info('User settings reset to defaults', { userId });

    const defaults = UserSettings.getDefaultTitleSettings();
    res.json({ settings: defaults, message: 'Settings reset to defaults' });
  } catch (error) {
    logger.error('Reset user settings error', { error: error.message, userId: req.user?.id });
    res.status(500).json({ error: 'Internal server error' });
  }
};
