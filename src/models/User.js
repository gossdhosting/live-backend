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
    subscription_type = 'monthly',
    youtube_restreaming = 0
  }) {
    const passwordHash = await bcrypt.hash(password, 10);

    const stmt = db.prepare(`
      INSERT INTO users (
        email, password_hash, name, role, plan_id,
        subscription_type, subscription_status, subscription_started_at, youtube_restreaming
      )
      VALUES (?, ?, ?, ?, ?, ?, 'active', CURRENT_TIMESTAMP, ?)
    `);

    const result = await stmt.run(email, passwordHash, name, role, plan_id, subscription_type, youtube_restreaming ? 1 : 0);
    return await this.findById(result.lastInsertRowid);
  }

  // Find user by ID (excludes password_hash)
  static async findById(id) {
    const stmt = db.prepare(`
      SELECT
        u.id, u.email, u.name, u.role, u.plan_id, u.subscription_type,
        u.subscription_status, u.subscription_started_at, u.subscription_expires_at,
        u.status, u.last_login_at, u.last_login_ip, u.created_at, u.updated_at,
        u.auth_provider, u.email_verified, u.profile_picture, u.youtube_restreaming,
        p.name as plan_name,
        p.max_concurrent_streams,
        p.max_bitrate,
        p.max_stream_duration,
        p.storage_limit_mb,
        p.custom_watermark,
        p.youtube_restreaming as plan_youtube_restreaming
      FROM users u
      LEFT JOIN plans p ON u.plan_id = p.id
      WHERE u.id = ?
    `);
    return await stmt.get(id);
  }

  // Find user by email (includes password hash for authentication)
  static async findByEmail(email) {
    const stmt = db.prepare('SELECT * FROM users WHERE email = ?');
    return await stmt.get(email);
  }

  // Get all users (admin only) - excludes password hashes
  static async getAll({ includeInactive = false } = {}) {
    const condition = includeInactive ? '' : "WHERE u.status = 'active'";
    const stmt = db.prepare(`
      SELECT
        u.id, u.email, u.name, u.role, u.plan_id, u.subscription_type,
        u.subscription_status, u.subscription_started_at, u.subscription_expires_at,
        u.status, u.last_login_at, u.last_login_ip, u.created_at, u.updated_at,
        u.auth_provider, u.email_verified, u.youtube_restreaming,
        p.name as plan_name
      FROM users u
      LEFT JOIN plans p ON u.plan_id = p.id
      ${condition}
      ORDER BY u.created_at DESC
    `);
    return await stmt.all();
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

    if (data.youtube_restreaming !== undefined) {
      fields.push('youtube_restreaming = ?');
      values.push(data.youtube_restreaming ? 1 : 0);
    }

    if (fields.length === 0) return null;

    fields.push('updated_at = CURRENT_TIMESTAMP');
    values.push(id);

    const stmt = db.prepare(`
      UPDATE users SET ${fields.join(', ')} WHERE id = ?
    `);

    await stmt.run(...values);
    return await this.findById(id);
  }

  // Update last login info
  static async updateLastLogin(id, ipAddress) {
    const stmt = db.prepare(`
      UPDATE users
      SET last_login_at = CURRENT_TIMESTAMP, last_login_ip = ?
      WHERE id = ?
    `);
    await stmt.run(ipAddress, id);
  }

  // Delete user (admin only)
  static async delete(id) {
    // This will cascade delete all user's channels, media files, etc.
    const stmt = db.prepare('DELETE FROM users WHERE id = ?');
    return await stmt.run(id);
  }

  // Get user statistics
  static async getUserStats(userId) {
    const channelCount = await db.prepare('SELECT COUNT(*) as count FROM channels WHERE user_id = ?').get(userId);
    const runningChannels = await db.prepare("SELECT COUNT(*) as count FROM channels WHERE user_id = ? AND status = 'running'").get(userId);
    const mediaFiles = await db.prepare('SELECT COUNT(*) as count FROM media_files WHERE user_id = ?').get(userId);
    const totalStorage = await db.prepare('SELECT COALESCE(SUM(file_size), 0) as total FROM media_files WHERE user_id = ?').get(userId);
    const platformConnections = await db.prepare('SELECT COUNT(*) as count FROM platform_connections WHERE user_id = ?').get(userId);

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
    const user = await this.findById(userId);
    if (!user) return null;

    const stats = await this.getUserStats(userId);

    // Get platform connection count (OAuth connections + RTMP templates count as platform connections)
    const platformConnectionsStmt = db.prepare(`
      SELECT COUNT(DISTINCT id) as count FROM platform_connections WHERE user_id = ?
    `);
    const platformConnectionCount = (await platformConnectionsStmt.get(userId))?.count || 0;

    // Get max_platform_connections from user's plan
    const planStmt = db.prepare('SELECT max_platform_connections FROM plans WHERE id = ?');
    const planData = await planStmt.get(user.plan_id);
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
  static async getUserWithPlan(userId) {
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
    const user = await stmt.get(userId);

    if (user) {
      // Remove password hash
      delete user.password_hash;
    }

    return user;
  }

  // Find user by Firebase UID
  static async findByFirebaseUid(firebaseUid) {
    const stmt = db.prepare('SELECT * FROM users WHERE firebase_uid = ?');
    return await stmt.get(firebaseUid);
  }

  // Create user from social login
  static async createSocialUser({
    email,
    name,
    auth_provider,
    firebase_uid,
    email_verified,
    profile_picture,
    plan_id,
    role = 'user',
    subscription_type = 'monthly'
  }) {
    const stmt = db.prepare(`
      INSERT INTO users (
        email, name, auth_provider, firebase_uid, email_verified,
        profile_picture, role, plan_id, subscription_type,
        subscription_status, subscription_started_at, password_hash
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', CURRENT_TIMESTAMP, NULL)
    `);

    const result = await stmt.run(
      email,
      name,
      auth_provider,
      firebase_uid,
      email_verified ? 1 : 0,
      profile_picture,
      role,
      plan_id,
      subscription_type
    );

    return await this.findById(result.lastInsertRowid);
  }

  // Update social user info (for existing users who link social accounts)
  static async updateSocialAuth(id, { firebase_uid, auth_provider, profile_picture, email_verified }) {
    const fields = [];
    const values = [];

    if (firebase_uid !== undefined) {
      fields.push('firebase_uid = ?');
      values.push(firebase_uid);
    }

    if (auth_provider !== undefined) {
      fields.push('auth_provider = ?');
      values.push(auth_provider);
    }

    if (profile_picture !== undefined) {
      fields.push('profile_picture = ?');
      values.push(profile_picture);
    }

    if (email_verified !== undefined) {
      fields.push('email_verified = ?');
      values.push(email_verified ? 1 : 0);
    }

    if (fields.length === 0) return null;

    fields.push('updated_at = CURRENT_TIMESTAMP');
    values.push(id);

    const stmt = db.prepare(`
      UPDATE users SET ${fields.join(', ')} WHERE id = ?
    `);

    await stmt.run(...values);
    return await this.findById(id);
  }
}

export default User;
