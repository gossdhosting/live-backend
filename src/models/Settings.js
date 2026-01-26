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
    const rows = await stmt.all();
    // Return plain objects to avoid any prototype chain pollution with connection objects
    return rows.map(row => ({ ...row }));
  }

  // Set a setting value
  static async set(key, value) {
    // Ensure value is always a string (not null)
    const stringValue = value != null ? String(value) : '';

    // Use direct query to avoid RETURNING id issue (settings table has no id column)
    await db.query(
      `INSERT INTO settings (key, value, updated_at)
       VALUES ($1, $2, CURRENT_TIMESTAMP)
       ON CONFLICT(key)
       DO UPDATE SET value = $2, updated_at = CURRENT_TIMESTAMP`,
      [key, stringValue]
    );

    return await this.get(key);
  }

  // Update multiple settings
  static async updateMultiple(settings) {
    // Filter out null/undefined values and convert to string
    const validSettings = Object.entries(settings)
      .filter(([key, value]) => value != null)
      .map(([key, value]) => [key, String(value)]);

    // Use transaction for PostgreSQL
    await db.transaction(async (client) => {
      for (const [key, value] of validSettings) {
        // Execute query directly with the transaction client
        await client.query(
          `INSERT INTO settings (key, value, updated_at)
           VALUES ($1, $2, CURRENT_TIMESTAMP)
           ON CONFLICT(key)
           DO UPDATE SET value = $2, updated_at = CURRENT_TIMESTAMP`,
          [key, value]
        );
      }
    });

    // Return fresh settings data as plain objects
    const allSettings = await this.getAll();
    return allSettings;
  }
}

export default Settings;
