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
      INSERT INTO settings (key, value, updated_at)
      VALUES (?, ?, CURRENT_TIMESTAMP)
      ON CONFLICT(key)
      DO UPDATE SET value = ?, updated_at = CURRENT_TIMESTAMP
    `);

    await stmt.run(key, value, value);
    return await this.get(key);
  }

  // Update multiple settings
  static async updateMultiple(settings) {
    const stmt = db.prepare(`
      INSERT INTO settings (key, value, updated_at)
      VALUES (?, ?, CURRENT_TIMESTAMP)
      ON CONFLICT(key)
      DO UPDATE SET value = ?, updated_at = CURRENT_TIMESTAMP
    `);

    // Use async transaction for PostgreSQL compatibility
    if (db.transaction) {
      await db.transaction(async () => {
        for (const [key, value] of Object.entries(settings)) {
          await stmt.run(key, value, value);
        }
      });
    } else {
      // Fallback for databases without transaction support
      for (const [key, value] of Object.entries(settings)) {
        await stmt.run(key, value, value);
      }
    }

    return await this.getAll();
  }
}

export default Settings;
