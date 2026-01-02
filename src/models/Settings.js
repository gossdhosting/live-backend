import db from './database.js';

class Settings {
  // Get a setting by key
  static get(key) {
    const stmt = db.prepare('SELECT * FROM settings WHERE key = ?');
    return stmt.get(key);
  }

  // Get all settings
  static getAll() {
    const stmt = db.prepare('SELECT * FROM settings ORDER BY key');
    return stmt.all();
  }

  // Set a setting value
  static set(key, value) {
    const stmt = db.prepare(`
      INSERT OR REPLACE INTO settings (key, value, updated_at)
      VALUES (?, ?, CURRENT_TIMESTAMP)
    `);

    stmt.run(key, value);
    return this.get(key);
  }

  // Update multiple settings
  static updateMultiple(settings) {
    const stmt = db.prepare(`
      INSERT OR REPLACE INTO settings (key, value, updated_at)
      VALUES (?, ?, CURRENT_TIMESTAMP)
    `);

    const transaction = db.transaction((items) => {
      for (const [key, value] of Object.entries(items)) {
        stmt.run(key, value);
      }
    });

    transaction(settings);
    return this.getAll();
  }
}

export default Settings;
