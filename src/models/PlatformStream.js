import db from './database.js';

class PlatformStream {
  // Create a new platform stream
  static async create(data) {
    const stmt = db.prepare(`
      INSERT INTO platform_streams (
        channel_id, platform_connection_id, platform, platform_stream_id,
        platform_broadcast_id, rtmp_url, stream_key, stream_title,
        stream_description, status, rtmp_destination_id
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    const info = await stmt.run(
      data.channel_id,
      data.platform_connection_id,
      data.platform,
      data.platform_stream_id || null,
      data.platform_broadcast_id || null,
      data.rtmp_url,
      data.stream_key,
      data.stream_title || null,
      data.stream_description || null,
      data.status || 'created',
      data.rtmp_destination_id || null
    );

    return await this.getById(info.lastInsertRowid);
  }

  // Get stream by ID
  static async getById(id) {
    const stmt = db.prepare('SELECT * FROM platform_streams WHERE id = ?');
    return await stmt.get(id);
  }

  // Get all streams for a channel
  static async getByChannelId(channelId) {
    const stmt = db.prepare('SELECT * FROM platform_streams WHERE channel_id = ? ORDER BY created_at DESC');
    return await stmt.all(channelId);
  }

  // Get stream by platform and channel
  static async getByPlatformAndChannel(platform, channelId) {
    const stmt = db.prepare(`
      SELECT * FROM platform_streams
      WHERE platform = ? AND channel_id = ?
      ORDER BY created_at DESC
      LIMIT 1
    `);
    return await stmt.get(platform, channelId);
  }

  // Update stream status
  static async updateStatus(id, status) {
    const stmt = db.prepare(`
      UPDATE platform_streams
      SET status = ?, updated_at = CURRENT_TIMESTAMP
      WHERE id = ?
    `);
    await stmt.run(status, id);
    return await this.getById(id);
  }

  // Update stream
  static async update(id, data) {
    const fields = [];
    const values = [];

    const allowedFields = [
      'platform_stream_id', 'platform_broadcast_id', 'rtmp_url', 'stream_key',
      'stream_title', 'stream_description', 'status', 'rtmp_destination_id'
    ];

    for (const field of allowedFields) {
      if (data[field] !== undefined) {
        fields.push(`${field} = ?`);
        values.push(data[field]);
      }
    }

    if (fields.length === 0) {
      return await this.getById(id);
    }

    fields.push('updated_at = CURRENT_TIMESTAMP');
    values.push(id);

    const stmt = db.prepare(`
      UPDATE platform_streams
      SET ${fields.join(', ')}
      WHERE id = ?
    `);

    await stmt.run(...values);
    return await this.getById(id);
  }

  // Delete stream
  static async delete(id) {
    const stmt = db.prepare('DELETE FROM platform_streams WHERE id = ?');
    return await stmt.run(id);
  }

  // Delete all streams for a channel
  static async deleteByChannelId(channelId) {
    const stmt = db.prepare('DELETE FROM platform_streams WHERE channel_id = ?');
    return await stmt.run(channelId);
  }

  // Get stream with connection details
  static async getWithConnection(id) {
    const stmt = db.prepare(`
      SELECT
        ps.*,
        pc.platform_user_name,
        pc.platform_page_name,
        pc.platform_channel_name,
        pc.access_token
      FROM platform_streams ps
      LEFT JOIN platform_connections pc ON ps.platform_connection_id = pc.id
      WHERE ps.id = ?
    `);
    return await stmt.get(id);
  }

  // Get all streams with connection details for a channel
  static async getAllWithConnectionByChannel(channelId) {
    const stmt = db.prepare(`
      SELECT
        ps.*,
        pc.platform_user_name,
        pc.platform_page_name,
        pc.platform_channel_name
      FROM platform_streams ps
      LEFT JOIN platform_connections pc ON ps.platform_connection_id = pc.id
      WHERE ps.channel_id = ?
      ORDER BY ps.created_at DESC
    `);
    return await stmt.all(channelId);
  }
}

export default PlatformStream;
