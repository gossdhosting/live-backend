import db from './database.js';
import crypto from 'crypto';

class Channel {
  // Generate a random 9-character stream key
  static generateStreamKey() {
    return crypto.randomBytes(5).toString('hex').substring(0, 9).toUpperCase();
  }

  // Create a new channel
  static async create({ user_id, name, description, input_url, auto_restart = 1, quality_preset = '720p', stream_title = '', input_type = 'youtube', media_file_id = null, loop_video = 0, title_enabled = 0 }) {
    // Generate unique stream key
    let streamKey;
    let attempts = 0;
    do {
      streamKey = this.generateStreamKey();
      const existing = await db.prepare('SELECT id FROM channels WHERE stream_key = ?').get(streamKey);
      if (!existing) break;
      attempts++;
    } while (attempts < 10);

    const stmt = db.prepare(`
      INSERT INTO channels (user_id, name, description, input_url, auto_restart, quality_preset, stream_title, input_type, media_file_id, loop_video, title_enabled, stream_key, status)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'stopped')
    `);

    const result = await stmt.run(user_id, name, description, input_url, auto_restart, quality_preset, stream_title, input_type, media_file_id, loop_video, title_enabled, streamKey);
    return this.findById(result.lastInsertRowid);
  }

  // Find channel by ID
  static async findById(id) {
    const stmt = db.prepare('SELECT * FROM channels WHERE id = ?');
    return await stmt.get(id);
  }

  // Find all channels
  static async findAll() {
    const stmt = db.prepare('SELECT * FROM channels ORDER BY created_at DESC');
    return await stmt.all();
  }

  // Find channels by user ID
  static async findByUserId(userId) {
    const stmt = db.prepare('SELECT * FROM channels WHERE user_id = ? ORDER BY created_at DESC');
    return await stmt.all(userId);
  }

  // Find channel by stream key (for RTMP authentication)
  static async findByStreamKey(streamKey) {
    const stmt = db.prepare('SELECT * FROM channels WHERE stream_key = ?');
    return await stmt.get(streamKey);
  }

  // Update channel
  static async update(id, data) {
    const allowedFields = ['name', 'description', 'input_url', 'auto_restart', 'quality_preset', 'stream_title', 'input_type', 'media_file_id', 'loop_video', 'title_enabled', 'watermark_enabled', 'watermark_path', 'watermark_position', 'watermark_opacity', 'watermark_scale'];
    const fields = [];
    const values = [];

    Object.keys(data).forEach((key) => {
      if (allowedFields.includes(key)) {
        fields.push(`${key} = ?`);
        values.push(data[key]);
      }
    });

    if (fields.length === 0) return null;

    fields.push('updated_at = CURRENT_TIMESTAMP');
    values.push(id);

    const stmt = db.prepare(`
      UPDATE channels SET ${fields.join(', ')} WHERE id = ?
    `);

    await stmt.run(...values);
    return this.findById(id);
  }

  // Update status and process info
  static async updateStatus(id, status, processId = null, errorMessage = null) {
    const stmt = db.prepare(`
      UPDATE channels
      SET status = ?,
          process_id = ?,
          error_message = ?,
          last_started_at = CASE WHEN ? = 'running' THEN CURRENT_TIMESTAMP ELSE last_started_at END,
          last_stopped_at = CASE WHEN ? = 'stopped' THEN CURRENT_TIMESTAMP ELSE last_stopped_at END,
          updated_at = CURRENT_TIMESTAMP
      WHERE id = ?
    `);

    await stmt.run(status, processId, errorMessage, status, status, id);
    return this.findById(id);
  }

  // Update output path
  static async updateOutputPath(id, outputPath) {
    const stmt = db.prepare(`
      UPDATE channels SET output_path = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?
    `);

    await stmt.run(outputPath, id);
  }

  // Delete channel
  static async delete(id) {
    const stmt = db.prepare('DELETE FROM channels WHERE id = ?');
    return await stmt.run(id);
  }

  // Get running channels count
  static async getRunningCount() {
    const stmt = db.prepare(`SELECT COUNT(*) as count FROM channels WHERE status = 'running'`);
    const result = await stmt.get();
    return result.count;
  }

  // Add log entry
  static async addLog(channelId, logType, message) {
    const stmt = db.prepare(`
      INSERT INTO stream_logs (channel_id, log_type, message)
      VALUES (?, ?, ?)
    `);

    await stmt.run(channelId, logType, message);
  }

  // Get logs for channel
  static async getLogs(channelId, limit = 100) {
    const stmt = db.prepare(`
      SELECT * FROM stream_logs
      WHERE channel_id = ?
      ORDER BY created_at DESC
      LIMIT ?
    `);

    return await stmt.all(channelId, limit);
  }
}

export default Channel;
