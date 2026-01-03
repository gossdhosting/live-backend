import db from './database.js';

class RtmpDestination {
  static getAll(channelId) {
    const stmt = db.prepare('SELECT * FROM rtmp_destinations WHERE channel_id = ? ORDER BY created_at DESC');
    return stmt.all(channelId);
  }

  static getById(id) {
    const stmt = db.prepare('SELECT * FROM rtmp_destinations WHERE id = ?');
    return stmt.get(id);
  }

  static create(data) {
    const stmt = db.prepare(`
      INSERT INTO rtmp_destinations (channel_id, template_id, platform, rtmp_url, stream_key, enabled)
      VALUES (?, ?, ?, ?, ?, ?)
    `);
    const result = stmt.run(
      data.channel_id,
      data.template_id || null,
      data.platform,
      data.rtmp_url,
      data.stream_key,
      data.enabled !== undefined ? data.enabled : 1
    );
    return this.getById(result.lastInsertRowid);
  }

  static getByChannelAndTemplate(channelId, templateId) {
    const stmt = db.prepare('SELECT * FROM rtmp_destinations WHERE channel_id = ? AND template_id = ?');
    return stmt.get(channelId, templateId);
  }

  static update(id, data) {
    const updates = [];
    const values = [];

    if (data.platform !== undefined) {
      updates.push('platform = ?');
      values.push(data.platform);
    }
    if (data.rtmp_url !== undefined) {
      updates.push('rtmp_url = ?');
      values.push(data.rtmp_url);
    }
    if (data.stream_key !== undefined) {
      updates.push('stream_key = ?');
      values.push(data.stream_key);
    }
    if (data.enabled !== undefined) {
      updates.push('enabled = ?');
      values.push(data.enabled);
    }

    updates.push('updated_at = CURRENT_TIMESTAMP');
    values.push(id);

    const stmt = db.prepare(`
      UPDATE rtmp_destinations
      SET ${updates.join(', ')}
      WHERE id = ?
    `);
    stmt.run(...values);
    return this.getById(id);
  }

  static delete(id) {
    const stmt = db.prepare('DELETE FROM rtmp_destinations WHERE id = ?');
    return stmt.run(id);
  }

  static getEnabledForChannel(channelId) {
    const stmt = db.prepare('SELECT * FROM rtmp_destinations WHERE channel_id = ? AND enabled = 1');
    return stmt.all(channelId);
  }
}

export default RtmpDestination;
