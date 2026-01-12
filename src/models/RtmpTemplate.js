import db from './database.js';

class RtmpTemplate {
  // Create a new RTMP template
  static async create({ name, platform, rtmp_url, stream_key, enabled = true }) {
    const stmt = db.prepare(`
      INSERT INTO rtmp_templates (name, platform, rtmp_url, stream_key, enabled)
      VALUES (?, ?, ?, ?, ?)
    `);

    const result = await stmt.run(
      name,
      platform,
      rtmp_url,
      stream_key,
      enabled ? true : false
    );
    // For PostgreSQL, use lastID; for SQLite, use lastInsertRowid
    const insertedId = result.lastID || result.lastInsertRowid;
    return await this.getById(insertedId);
  }

  // Get template by ID
  static async getById(id) {
    const stmt = db.prepare('SELECT * FROM rtmp_templates WHERE id = ?');
    return await stmt.get(id);
  }

  // Get all templates
  static async getAll() {
    const stmt = db.prepare('SELECT * FROM rtmp_templates ORDER BY created_at DESC');
    return await stmt.all();
  }

  // Get only enabled templates
  static async getEnabled() {
    const stmt = db.prepare('SELECT * FROM rtmp_templates WHERE enabled = TRUE ORDER BY created_at DESC');
    return await stmt.all();
  }

  // Update template
  static async update(id, { name, platform, rtmp_url, stream_key, enabled }) {
    console.log('[RtmpTemplate.update] Called with:', { id, name, platform, rtmp_url, stream_key, enabled });

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
    if (enabled !== undefined) {
      fields.push('enabled = ?');
      values.push(enabled ? true : false);
    }

    console.log('[RtmpTemplate.update] Fields to update:', fields);
    console.log('[RtmpTemplate.update] Values:', values);

    if (fields.length === 0) {
      console.log('[RtmpTemplate.update] No fields to update, returning null');
      return null;
    }

    fields.push('updated_at = CURRENT_TIMESTAMP');
    values.push(id);

    const sql = `UPDATE rtmp_templates SET ${fields.join(', ')} WHERE id = ?`;
    console.log('[RtmpTemplate.update] SQL:', sql);
    console.log('[RtmpTemplate.update] Final values:', values);

    const stmt = db.prepare(sql);
    const result = await stmt.run(...values);
    console.log('[RtmpTemplate.update] Update result:', result);

    const updated = await this.getById(id);
    console.log('[RtmpTemplate.update] Retrieved updated template:', updated);
    return updated;
  }

  // Delete template
  static async delete(id) {
    const stmt = db.prepare('DELETE FROM rtmp_templates WHERE id = ?');
    return await stmt.run(id);
  }
}

export default RtmpTemplate;
