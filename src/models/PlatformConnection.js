import db from './database.js';

class PlatformConnection {
  // Create a new platform connection
  static async create(data) {
    const stmt = db.prepare(`
      INSERT INTO platform_connections (
        platform, user_id, access_token, refresh_token, token_expires_at,
        platform_user_id, platform_user_name, platform_user_email,
        platform_page_id, platform_page_name, platform_channel_id, platform_channel_name,
        available_pages, scopes
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    const info = await stmt.run(
      data.platform,
      data.user_id,
      data.access_token,
      data.refresh_token || null,
      data.token_expires_at || null,
      data.platform_user_id || null,
      data.platform_user_name || null,
      data.platform_user_email || null,
      data.platform_page_id || null,
      data.platform_page_name || null,
      data.platform_channel_id || null,
      data.platform_channel_name || null,
      data.available_pages || null,
      data.scopes ? JSON.stringify(data.scopes) : null
    );

    return await this.getById(info.lastInsertRowid);
  }

  // Get connection by ID
  static async getById(id) {
    const stmt = db.prepare('SELECT * FROM platform_connections WHERE id = ?');
    const connection = await stmt.get(id);
    if (connection && connection.scopes) {
      connection.scopes = JSON.parse(connection.scopes);
    }
    return connection;
  }

  // Get all connections for a user
  static async getByUserId(userId) {
    const stmt = db.prepare('SELECT * FROM platform_connections WHERE user_id = ? ORDER BY created_at DESC');
    const connections = await stmt.all(userId);
    return connections.map(conn => {
      if (conn.scopes) {
        conn.scopes = JSON.parse(conn.scopes);
      }
      return conn;
    });
  }

  // Get connection by platform and user
  static async getByPlatformAndUser(platform, userId) {
    const stmt = db.prepare('SELECT * FROM platform_connections WHERE platform = ? AND user_id = ? ORDER BY created_at DESC LIMIT 1');
    const connection = await stmt.get(platform, userId);
    if (connection && connection.scopes) {
      connection.scopes = JSON.parse(connection.scopes);
    }
    return connection;
  }

  // Update connection
  static async update(id, data) {
    const fields = [];
    const values = [];

    const allowedFields = [
      'access_token', 'refresh_token', 'token_expires_at',
      'platform_user_id', 'platform_user_name', 'platform_user_email',
      'platform_page_id', 'platform_page_name', 'platform_channel_id', 'platform_channel_name',
      'available_pages', 'scopes'
    ];

    for (const field of allowedFields) {
      if (data[field] !== undefined) {
        fields.push(`${field} = ?`);
        if (field === 'scopes' && data[field]) {
          values.push(JSON.stringify(data[field]));
        } else {
          values.push(data[field]);
        }
      }
    }

    if (fields.length === 0) {
      return await this.getById(id);
    }

    fields.push('updated_at = CURRENT_TIMESTAMP');
    values.push(id);

    const stmt = db.prepare(`
      UPDATE platform_connections
      SET ${fields.join(', ')}
      WHERE id = ?
    `);

    await stmt.run(...values);
    return await this.getById(id);
  }

  // Delete connection
  static async delete(id) {
    const stmt = db.prepare('DELETE FROM platform_connections WHERE id = ?');
    return await stmt.run(id);
  }

  // Delete all connections for a user and platform
  static async deleteByPlatformAndUser(platform, userId) {
    const stmt = db.prepare('DELETE FROM platform_connections WHERE platform = ? AND user_id = ?');
    return await stmt.run(platform, userId);
  }

  // Check if token is expired
  static isTokenExpired(connection) {
    if (!connection.token_expires_at) {
      return false;
    }
    const expiresAt = new Date(connection.token_expires_at);
    const now = new Date();
    // Consider expired if less than 5 minutes remaining
    return expiresAt.getTime() - now.getTime() < 5 * 60 * 1000;
  }
}

export default PlatformConnection;
