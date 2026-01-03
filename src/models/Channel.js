import db from './database.js';

class Channel {
  // Create a new channel
  static create({ name, description, input_url, auto_restart = 1 }) {
    const stmt = db.prepare(`
      INSERT INTO channels (name, description, input_url, auto_restart, status)
      VALUES (?, ?, ?, ?, 'stopped')
    `);

    const result = stmt.run(name, description, input_url, auto_restart);
    return this.findById(result.lastInsertRowid);
  }

  // Find channel by ID
  static findById(id) {
    const stmt = db.prepare('SELECT * FROM channels WHERE id = ?');
    return stmt.get(id);
  }

  // Find all channels
  static findAll() {
    const stmt = db.prepare('SELECT * FROM channels ORDER BY created_at DESC');
    return stmt.all();
  }

  // Update channel
  static update(id, data) {
    const allowedFields = ['name', 'description', 'input_url', 'auto_restart', 'watermark_enabled', 'watermark_path', 'watermark_position', 'watermark_opacity'];
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

    stmt.run(...values);
    return this.findById(id);
  }

  // Update status and process info
  static updateStatus(id, status, processId = null, errorMessage = null) {
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

    stmt.run(status, processId, errorMessage, status, status, id);
    return this.findById(id);
  }

  // Update output path
  static updateOutputPath(id, outputPath) {
    const stmt = db.prepare(`
      UPDATE channels SET output_path = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?
    `);

    stmt.run(outputPath, id);
  }

  // Delete channel
  static delete(id) {
    const stmt = db.prepare('DELETE FROM channels WHERE id = ?');
    return stmt.run(id);
  }

  // Get running channels count
  static getRunningCount() {
    const stmt = db.prepare(`SELECT COUNT(*) as count FROM channels WHERE status = 'running'`);
    const result = stmt.get();
    return result.count;
  }

  // Add log entry
  static addLog(channelId, logType, message) {
    const stmt = db.prepare(`
      INSERT INTO stream_logs (channel_id, log_type, message)
      VALUES (?, ?, ?)
    `);

    stmt.run(channelId, logType, message);
  }

  // Get logs for channel
  static getLogs(channelId, limit = 100) {
    const stmt = db.prepare(`
      SELECT * FROM stream_logs
      WHERE channel_id = ?
      ORDER BY created_at DESC
      LIMIT ?
    `);

    return stmt.all(channelId, limit);
  }
}

export default Channel;
