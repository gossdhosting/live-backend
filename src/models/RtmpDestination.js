import db from './database.js';

class RtmpDestination {
  static async getAll(channelId) {
    const stmt = db.prepare('SELECT * FROM rtmp_destinations WHERE channel_id = ? ORDER BY created_at DESC');
    return await stmt.all(channelId);
  }

  static async getById(id) {
    const stmt = db.prepare('SELECT * FROM rtmp_destinations WHERE id = ?');
    return await stmt.get(id);
  }

  static async create(data) {
    const stmt = db.prepare(`
      INSERT INTO rtmp_destinations (channel_id, template_id, platform, rtmp_url, stream_key, enabled, custom_bitrate)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `);
    const result = await stmt.run(
      data.channel_id,
      data.template_id || null,
      data.platform,
      data.rtmp_url,
      data.stream_key,
      data.enabled !== undefined ? data.enabled : true,
      data.custom_bitrate || null
    );
    // For PostgreSQL, use lastID; for SQLite, use lastInsertRowid
    const insertedId = result.lastID || result.lastInsertRowid;
    return await this.getById(insertedId);
  }

  static async getByChannelAndTemplate(channelId, templateId) {
    const stmt = db.prepare('SELECT * FROM rtmp_destinations WHERE channel_id = ? AND template_id = ?');
    return await stmt.get(channelId, templateId);
  }

  static async update(id, data) {
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
    if (data.custom_bitrate !== undefined) {
      updates.push('custom_bitrate = ?');
      values.push(data.custom_bitrate);
    }

    updates.push('updated_at = CURRENT_TIMESTAMP');
    values.push(id);

    const stmt = db.prepare(`
      UPDATE rtmp_destinations
      SET ${updates.join(', ')}
      WHERE id = ?
    `);
    await stmt.run(...values);
    return await this.getById(id);
  }

  static async delete(id) {
    const stmt = db.prepare('DELETE FROM rtmp_destinations WHERE id = ?');
    return await stmt.run(id);
  }

  static async getEnabledForChannel(channelId) {
    const stmt = db.prepare(`
      SELECT
        d.*,
        t.video_bitrate as template_video_bitrate,
        t.audio_bitrate as template_audio_bitrate,
        t.profile as template_profile,
        t.preset as template_preset,
        t.fps as template_fps,
        t.video_orientation as template_video_orientation
      FROM rtmp_destinations d
      LEFT JOIN rtmp_templates t ON d.template_id = t.id
      WHERE d.channel_id = ? AND d.enabled = TRUE
    `);
    return await stmt.all(channelId);
  }
}

export default RtmpDestination;
