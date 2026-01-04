import db from './database.js';

class RtmpTemplate {
  // Create a new RTMP template
  static create({ name, platform, rtmp_url, stream_key, video_bitrate, audio_bitrate, profile, preset, fps, enabled = 1 }) {
    const stmt = db.prepare(`
      INSERT INTO rtmp_templates (name, platform, rtmp_url, stream_key, video_bitrate, audio_bitrate, profile, preset, fps, enabled)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    const result = stmt.run(
      name,
      platform,
      rtmp_url,
      stream_key,
      video_bitrate || null,
      audio_bitrate || null,
      profile || null,
      preset || null,
      fps || null,
      enabled ? 1 : 0
    );
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

  // Get only enabled templates
  static getEnabled() {
    const stmt = db.prepare('SELECT * FROM rtmp_templates WHERE enabled = 1 ORDER BY created_at DESC');
    return stmt.all();
  }

  // Update template
  static update(id, { name, platform, rtmp_url, stream_key, video_bitrate, audio_bitrate, profile, preset, fps, enabled }) {
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
    if (video_bitrate !== undefined) {
      fields.push('video_bitrate = ?');
      values.push(video_bitrate || null);
    }
    if (audio_bitrate !== undefined) {
      fields.push('audio_bitrate = ?');
      values.push(audio_bitrate || null);
    }
    if (profile !== undefined) {
      fields.push('profile = ?');
      values.push(profile || null);
    }
    if (preset !== undefined) {
      fields.push('preset = ?');
      values.push(preset || null);
    }
    if (fps !== undefined) {
      fields.push('fps = ?');
      values.push(fps || null);
    }
    if (enabled !== undefined) {
      fields.push('enabled = ?');
      values.push(enabled ? 1 : 0);
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
