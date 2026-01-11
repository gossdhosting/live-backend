import db from './database.js';

class Plan {
  // Get all plans (only visible, non-hidden plans for users)
  static async getAll() {
    const stmt = db.prepare('SELECT * FROM plans WHERE is_active = TRUE AND (is_hidden IS NULL OR is_hidden = FALSE) ORDER BY price_monthly ASC');
    return await stmt.all();
  }

  // Get all plans including hidden (for admin)
  static async getAllForAdmin() {
    const stmt = db.prepare('SELECT * FROM plans WHERE is_active = TRUE ORDER BY price_monthly ASC');
    return await stmt.all();
  }

  // Get all plans with subscriber statistics (admin only - includes hidden plans)
  static async getAllWithStats() {
    const stmt = db.prepare(`
      SELECT
        p.*,
        COUNT(u.id) as subscriber_count,
        COUNT(CASE WHEN u.subscription_status = 'active' THEN 1 END) as active_subscribers
      FROM plans p
      LEFT JOIN users u ON p.id = u.plan_id
      WHERE p.is_active = TRUE
      GROUP BY p.id
      ORDER BY p.price_monthly ASC
    `);
    return await stmt.all();
  }

  // Get plan by ID
  static async getById(id) {
    const stmt = db.prepare('SELECT * FROM plans WHERE id = ?');
    return await stmt.get(id);
  }

  // Get plan by name
  static async getByName(name) {
    const stmt = db.prepare('SELECT * FROM plans WHERE name = ?');
    return await stmt.get(name);
  }

  // Create new plan (admin only)
  static async create({
    name,
    description,
    price_monthly,
    price_yearly,
    max_concurrent_streams,
    max_bitrate,
    max_stream_duration,
    storage_limit_mb,
    custom_watermark,
    max_platform_connections,
    youtube_restreaming
  }) {
    const stmt = db.prepare(`
      INSERT INTO plans (
        name, description, price_monthly, price_yearly,
        max_concurrent_streams, max_bitrate, max_stream_duration,
        storage_limit_mb, custom_watermark, max_platform_connections, youtube_restreaming
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    const result = await stmt.run(
      name,
      description || null,
      price_monthly,
      price_yearly,
      max_concurrent_streams,
      max_bitrate,
      max_stream_duration || null,
      storage_limit_mb,
      custom_watermark ? 1 : 0,
      max_platform_connections || 1,
      youtube_restreaming ? 1 : 0
    );

    return await this.getById(result.lastInsertRowid);
  }

  // Update plan (admin only)
  static async update(id, data) {
    const fields = [];
    const values = [];

    const allowedFields = [
      'name',
      'description',
      'price_monthly',
      'price_yearly',
      'max_concurrent_streams',
      'max_bitrate',
      'max_stream_duration',
      'storage_limit_mb',
      'custom_watermark',
      'max_platform_connections',
      'is_active',
      'is_hidden',
      'youtube_restreaming'
    ];

    allowedFields.forEach(field => {
      if (data[field] !== undefined) {
        fields.push(`${field} = ?`);
        if (field === 'custom_watermark' || field === 'is_active' || field === 'is_hidden' || field === 'youtube_restreaming') {
          values.push(data[field] ? 1 : 0);
        } else {
          values.push(data[field]);
        }
      }
    });

    if (fields.length === 0) return null;

    fields.push('updated_at = CURRENT_TIMESTAMP');
    values.push(id);

    const stmt = db.prepare(`
      UPDATE plans SET ${fields.join(', ')} WHERE id = ?
    `);

    await stmt.run(...values);
    return await this.getById(id);
  }

  // Delete plan (admin only) - soft delete by setting is_active = 0
  static async delete(id) {
    // Check if any users are using this plan
    const usersCount = await db.prepare('SELECT COUNT(*) as count FROM users WHERE plan_id = ?').get(id);

    if (usersCount.count > 0) {
      throw new Error(`Cannot delete plan: ${usersCount.count} user(s) are currently subscribed to this plan`);
    }

    const stmt = db.prepare('UPDATE plans SET is_active = FALSE, updated_at = CURRENT_TIMESTAMP WHERE id = ?');
    return await stmt.run(id);
  }

  // Hard delete (use with caution)
  static async hardDelete(id) {
    const stmt = db.prepare('DELETE FROM plans WHERE id = ?');
    return await stmt.run(id);
  }

  // Get user count for each plan
  static async getPlanStats() {
    const stmt = db.prepare(`
      SELECT
        p.id,
        p.name,
        p.price_monthly,
        p.price_yearly,
        COUNT(u.id) as subscriber_count,
        COUNT(CASE WHEN u.subscription_status = 'active' THEN 1 END) as active_subscribers
      FROM plans p
      LEFT JOIN users u ON p.id = u.plan_id
      WHERE p.is_active = TRUE
      GROUP BY p.id
      ORDER BY p.price_monthly ASC
    `);
    return await stmt.all();
  }

  // Check if user can perform action based on plan limits
  static async checkLimit(planId, limitType) {
    const plan = await this.getById(planId);
    if (!plan) return null;

    const limits = {
      max_concurrent_streams: plan.max_concurrent_streams,
      max_bitrate: plan.max_bitrate,
      max_stream_duration: plan.max_stream_duration, // null = unlimited
      storage_limit_mb: plan.storage_limit_mb,
      custom_watermark: plan.custom_watermark === true,
      max_platform_connections: plan.max_platform_connections || 1
    };

    return limits[limitType];
  }
}

export default Plan;
