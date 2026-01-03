import db from './database.js';

class RtmpTemplate {
  // Create a new RTMP template
  static create({ name, platform, rtmp_url, stream_key }) {
    const stmt = db.prepare(`
      INSERT INTO rtmp_templates (name, platform, rtmp_url, stream_key)
      VALUES (?, ?, ?, ?)
    `);

    const result = stmt.run(name, platform, rtmp_url, stream_key);
    return this.getById(result.lastInsertRowid);
  }

  // Get template by ID
  static getById(id) {
    const stmt = db.prepare('SELECT * FROM rtmp_templates WHERE id = ?');
    return stmt.get(id);
  }

  // Get all templates
  static getAll() {
    const stmt = db.prepare('SELECT * FROM rtmp_templates ORDER BY created_at DESC');
    return stmt.all();
  }

  // Update template
  static update(id, { name, platform, rtmp_url, stream_key }) {
    const fields = [];
    const values = [];

    if (name !== undefined) {
      fields.push('name = ?');
      values.push(name);
    }
    if (platform !== undefined) {
      fields.push('platform = ?');
      values.push(platform);
    }
    if (rtmp_url !== undefined) {
      fields.push('rtmp_url = ?');
      values.push(rtmp_url);
    }
    if (stream_key !== undefined) {
      fields.push('stream_key = ?');
      values.push(stream_key);
    }

    if (fields.length === 0) return null;

    fields.push('updated_at = CURRENT_TIMESTAMP');
    values.push(id);

    const stmt = db.prepare(`
      UPDATE rtmp_templates SET ${fields.join(', ')} WHERE id = ?
    `);

    stmt.run(...values);
    return this.getById(id);
  }

  // Delete template
  static delete(id) {
    const stmt = db.prepare('DELETE FROM rtmp_templates WHERE id = ?');
    return stmt.run(id);
  }
}

export default RtmpTemplate;
