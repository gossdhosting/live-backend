import db from './database.js';

class UserSettings {
  // Get a user setting by key
  static get(userId, key) {
    const stmt = db.prepare('SELECT * FROM user_settings WHERE user_id = ? AND key = ?');
    return stmt.get(userId, key);
  }

  // Get all settings for a user
  static getAll(userId) {
    const stmt = db.prepare('SELECT key, value FROM user_settings WHERE user_id = ? ORDER BY key');
    const rows = stmt.all(userId);

    // Convert to object format
    const settings = {};
    rows.forEach(row => {
      settings[row.key] = row.value;
    });

    return settings;
  }

  // Get all settings with defaults from global settings
  static getAllWithDefaults(userId) {
    // Get user-specific settings
    const userSettings = this.getAll(userId);

    // Get global defaults for title settings
    const globalSettings = db.prepare(`
      SELECT key, value FROM settings
      WHERE key LIKE 'title_%'
    `).all();

    // Merge: user settings override global defaults
    const merged = {};
    globalSettings.forEach(row => {
      merged[row.key] = row.value;
    });

    Object.assign(merged, userSettings);

    return merged;
  }

  // Set a user setting value
  static set(userId, key, value) {
    const stmt = db.prepare(`
      INSERT INTO user_settings (user_id, key, value, updated_at)
      VALUES (?, ?, ?, CURRENT_TIMESTAMP)
      ON CONFLICT(user_id, key)
      DO UPDATE SET value = ?, updated_at = CURRENT_TIMESTAMP
    `);

    stmt.run(userId, key, value, value);
    return this.get(userId, key);
  }

  // Update multiple settings for a user
  static updateMultiple(userId, settings) {
    const stmt = db.prepare(`
      INSERT INTO user_settings (user_id, key, value, updated_at)
      VALUES (?, ?, ?, CURRENT_TIMESTAMP)
      ON CONFLICT(user_id, key)
      DO UPDATE SET value = ?, updated_at = CURRENT_TIMESTAMP
    `);

    const transaction = db.transaction((items) => {
      for (const [key, value] of Object.entries(items)) {
        stmt.run(userId, key, value, value);
      }
    });

    transaction(settings);
    return this.getAll(userId);
  }

  // Delete a user setting
  static delete(userId, key) {
    const stmt = db.prepare('DELETE FROM user_settings WHERE user_id = ? AND key = ?');
    return stmt.run(userId, key);
  }

  // Delete all settings for a user
  static deleteAll(userId) {
    const stmt = db.prepare('DELETE FROM user_settings WHERE user_id = ?');
    return stmt.run(userId);
  }

  // Get default title settings (for new users or reset)
  static getDefaultTitleSettings() {
    const stmt = db.prepare(`
      SELECT key, value FROM settings
      WHERE key LIKE 'title_%'
    `);
    const rows = stmt.all();

    const defaults = {};
    rows.forEach(row => {
      defaults[row.key] = row.value;
    });

    return defaults;
  }
}

export default UserSettings;
