import db from './database.js';

class Settings {
  // Get a setting by key
  static async get(key) {
    const stmt = db.prepare('SELECT * FROM settings WHERE key = ?');
    return await stmt.get(key);
  }

  // Get all settings
  static async getAll() {
    const stmt = db.prepare('SELECT * FROM settings ORDER BY key');
    return await stmt.all();
  }

  // Set a setting value
  static async set(key, value) {
    const stmt = db.prepare(`
      INSERT OR REPLACE INTO settings (key, value, updated_at)
      VALUES (?, ?, CURRENT_TIMESTAMP)
    `);

    await stmt.run(key, value);
    return await this.get(key);
  }

  // Update multiple settings
  static async updateMultiple(settings) {
    const stmt = db.prepare(`
      INSERT OR REPLACE INTO settings (key, value, updated_at)
      VALUES (?, ?, CURRENT_TIMESTAMP)
    `);

    const transaction = db.transaction((items) => {
      for (const [key, value] of Object.entries(items)) {
        stmt.run(key, value);
      }
    });

    await transaction(settings);
    return await this.getAll();
  }
}

export default Settings;
