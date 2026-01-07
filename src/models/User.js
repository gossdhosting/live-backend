import db from './database.js';
import bcrypt from 'bcryptjs';

class User {
  // Create a new user
  static async create({
    email,
    password,
    name,
    role = 'user',
    plan_id,
    subscription_type = 'monthly'
  }) {
    const passwordHash = await bcrypt.hash(password, 10);

    const stmt = db.prepare(`
      INSERT INTO users (
        email, password_hash, name, role, plan_id,
        subscription_type, subscription_status, subscription_started_at
      )
      VALUES (?, ?, ?, ?, ?, ?, 'active', CURRENT_TIMESTAMP)
    `);

    const result = stmt.run(email, passwordHash, name, role, plan_id, subscription_type);
    return this.findById(result.lastInsertRowid);
  }

  // Find user by ID (excludes password_hash)
  static findById(id) {
    const stmt = db.prepare(`
      SELECT
        u.id, u.email, u.name, u.role, u.plan_id, u.subscription_type,
        u.subscription_status, u.subscription_started_at, u.subscription_expires_at,
        u.status, u.last_login_at, u.last_login_ip, u.created_at, u.updated_at,
        p.name as plan_name,
        p.max_concurrent_streams,
        p.max_bitrate,
        p.max_stream_duration,
        p.storage_limit_mb,
        p.custom_watermark
      FROM users u
      LEFT JOIN plans p ON u.plan_id = p.id
      WHERE u.id = ?
    `);
    return stmt.get(id);
  }

  // Find user by email (includes password hash for authentication)
  static findByEmail(email) {
    const stmt = db.prepare('SELECT * FROM users WHERE email = ?');
    return stmt.get(email);
  }

  // Get all users (admin only) - excludes password hashes
  static getAll({ includeInactive = false } = {}) {
    const condition = includeInactive ? '' : "WHERE u.status = 'active'";
    const stmt = db.prepare(`
      SELECT
        u.id, u.email, u.name, u.role, u.plan_id, u.subscription_type,
        u.subscription_status, u.subscription_started_at, u.subscription_expires_at,
        u.status, u.last_login_at, u.last_login_ip, u.created_at, u.updated_at,
        p.name as plan_name
      FROM users u
      LEFT JOIN plans p ON u.plan_id = p.id
      ${condition}
      ORDER BY u.created_at DESC
    `);
    return stmt.all();
  }

  // Verify password
  static async verifyPassword(plainPassword, passwordHash) {
    return bcrypt.compare(plainPassword, passwordHash);
  }

  // Update user
  static async update(id, data) {
    const fields = [];
    const values = [];

    if (data.name !== undefined) {
      fields.push('name = ?');
      values.push(data.name);
    }

    if (data.email !== undefined) {
      fields.push('email = ?');
      values.push(data.email);
    }

    if (data.password) {
      const passwordHash = await bcrypt.hash(data.password, 10);
      fields.push('password_hash = ?');
      values.push(passwordHash);
    }

    if (data.role !== undefined) {
      fields.push('role = ?');
      values.push(data.role);
    }

    if (data.plan_id !== undefined) {
      fields.push('plan_id = ?');
      values.push(data.plan_id);
    }

    if (data.subscription_type !== undefined) {
      fields.push('subscription_type = ?');
      values.push(data.subscription_type);
    }

    if (data.subscription_status !== undefined) {
      fields.push('subscription_status = ?');
      values.push(data.subscription_status);
    }

    if (data.subscription_expires_at !== undefined) {
      fields.push('subscription_expires_at = ?');
      values.push(data.subscription_expires_at);
    }

    if (data.status !== undefined) {
      fields.push('status = ?');
      values.push(data.status);
    }

    if (fields.length === 0) return null;

    fields.push('updated_at = CURRENT_TIMESTAMP');
    values.push(id);

    const stmt = db.prepare(`
      UPDATE users SET ${fields.join(', ')} WHERE id = ?
    `);

    stmt.run(...values);
    return this.findById(id);
  }

  // Update last login info
  static updateLastLogin(id, ipAddress) {
    const stmt = db.prepare(`
      UPDATE users
      SET last_login_at = CURRENT_TIMESTAMP, last_login_ip = ?
      WHERE id = ?
    `);
    stmt.run(ipAddress, id);
  }

  // Delete user (admin only)
  static delete(id) {
    // This will cascade delete all user's channels, media files, etc.
    const stmt = db.prepare('DELETE FROM users WHERE id = ?');
    return stmt.run(id);
  }

  // Get user statistics
  static getUserStats(userId) {
    const channelCount = db.prepare('SELECT COUNT(*) as count FROM channels WHERE user_id = ?').get(userId);
    const runningChannels = db.prepare("SELECT COUNT(*) as count FROM channels WHERE user_id = ? AND status = 'running'").get(userId);
    const mediaFiles = db.prepare('SELECT COUNT(*) as count FROM media_files WHERE user_id = ?').get(userId);
    const totalStorage = db.prepare('SELECT COALESCE(SUM(file_size), 0) as total FROM media_files WHERE user_id = ?').get(userId);
    const platformConnections = db.prepare('SELECT COUNT(*) as count FROM platform_connections WHERE user_id = ?').get(userId);

    return {
      total_channels: channelCount.count,
      running_channels: runningChannels.count,
      media_files: mediaFiles.count,
      storage_used_mb: Math.round(totalStorage.total / (1024 * 1024)),
      platform_connections: platformConnections.count
    };
  }

  // Check if user has reached plan limits
  static async checkPlanLimits(userId) {
    const user = this.findById(userId);
    if (!user) return null;

    const stats = this.getUserStats(userId);

    // Get platform connection count (OAuth connections + RTMP templates count as platform connections)
    const platformConnectionsStmt = db.prepare(`
      SELECT COUNT(DISTINCT id) as count FROM platform_connections WHERE user_id = ?
    `);
    const platformConnectionCount = platformConnectionsStmt.get(userId)?.count || 0;

    // Get max_platform_connections from user's plan
    const planStmt = db.prepare('SELECT max_platform_connections FROM plans WHERE id = ?');
    const planData = planStmt.get(user.plan_id);
    const maxPlatformConnections = planData?.max_platform_connections || 1;

    const limits = {
      max_concurrent_streams: user.max_concurrent_streams,
      max_bitrate: user.max_bitrate,
      max_stream_duration: user.max_stream_duration,
      storage_limit_mb: user.storage_limit_mb,
      custom_watermark: user.custom_watermark === 1,
      max_platform_connections: maxPlatformConnections
    };

    const usage = {
      concurrent_streams: stats.running_channels,
      storage_mb: stats.storage_used_mb,
      platform_connections: platformConnectionCount
    };

    const canCreate = {
      channel: stats.total_channels < 100, // Global hard limit
      stream: usage.concurrent_streams < limits.max_concurrent_streams,
      media: usage.storage_mb < limits.storage_limit_mb,
      watermark: limits.custom_watermark,
      platform_connection: usage.platform_connections < limits.max_platform_connections
    };

    return {
      limits,
      usage,
      canCreate,
      user_plan: user.plan_name
    };
  }

  // Get user with full plan details
  static getUserWithPlan(userId) {
    const stmt = db.prepare(`
      SELECT
        u.*,
        p.name as plan_name,
        p.description as plan_description,
        p.price_monthly,
        p.price_yearly,
        p.max_concurrent_streams,
        p.max_bitrate,
        p.max_stream_duration,
        p.storage_limit_mb,
        p.custom_watermark
      FROM users u
      LEFT JOIN plans p ON u.plan_id = p.id
      WHERE u.id = ?
    `);
    const user = stmt.get(userId);

    if (user) {
      // Remove password hash
      delete user.password_hash;
    }

    return user;
  }
}

export default User;
