import db from './database.js';

class UserSettings {
  // Get a user setting by key
  static async get(userId, key) {
    const stmt = db.prepare('SELECT * FROM user_settings WHERE user_id = ? AND key = ?');
    return await stmt.get(userId, key);
  }

  // Get all settings for a user
  static async getAll(userId) {
    const stmt = db.prepare('SELECT key, value FROM user_settings WHERE user_id = ? ORDER BY key');
    const rows = await stmt.all(userId);

    // Convert to object format
    const settings = {};
    rows.forEach(row => {
      settings[row.key] = row.value;
    });

    return settings;
  }

  // Get all settings with defaults from global settings
  static async getAllWithDefaults(userId) {
    // Get user-specific settings
    const userSettings = await this.getAll(userId);

    // Get global defaults for title settings
    const globalSettings = await db.prepare(`
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
  static async set(userId, key, value) {
    const stmt = db.prepare(`
      INSERT INTO user_settings (user_id, key, value, updated_at)
      VALUES (?, ?, ?, CURRENT_TIMESTAMP)
      ON CONFLICT(user_id, key)
      DO UPDATE SET value = ?, updated_at = CURRENT_TIMESTAMP
    `);

    await stmt.run(userId, key, value, value);
    return await this.get(userId, key);
  }

  // Update multiple settings for a user
  static async updateMultiple(userId, settings) {
    const stmt = db.prepare(`
      INSERT INTO user_settings (user_id, key, value, updated_at)
      VALUES (?, ?, ?, CURRENT_TIMESTAMP)
      ON CONFLICT(user_id, key)
      DO UPDATE SET value = ?, updated_at = CURRENT_TIMESTAMP
    `);

    // Filter out null/undefined values and convert to string
    const validSettings = Object.entries(settings)
      .filter(([key, value]) => value != null)
      .map(([key, value]) => [key, String(value)]); // Ensure value is always a string

    // Use different transaction approach based on database type
    if (db.transaction) {
      // PostgreSQL: async transaction with callback
      await db.transaction(async () => {
        for (const [key, value] of validSettings) {
          await stmt.run(userId, key, value, value);
        }
      });
    } else {
      // Fallback: run statements sequentially without transaction
      for (const [key, value] of validSettings) {
        await stmt.run(userId, key, value, value);
      }
    }

    return await this.getAll(userId);
  }

  // Delete a user setting
  static async delete(userId, key) {
    const stmt = db.prepare('DELETE FROM user_settings WHERE user_id = ? AND key = ?');
    return await stmt.run(userId, key);
  }

  // Delete all settings for a user
  static async deleteAll(userId) {
    const stmt = db.prepare('DELETE FROM user_settings WHERE user_id = ?');
    return await stmt.run(userId);
  }

  // Get default title settings (for new users or reset)
  static async getDefaultTitleSettings() {
    const stmt = db.prepare(`
      SELECT key, value FROM settings
      WHERE key LIKE 'title_%'
    `);
    const rows = await stmt.all();

    const defaults = {};
    rows.forEach(row => {
      defaults[row.key] = row.value;
    });

    return defaults;
  }
}

export default UserSettings;
