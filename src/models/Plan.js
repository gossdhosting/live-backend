import db from './database.js';

class Plan {
  // Get all plans (only visible, non-hidden plans for users)
  static getAll() {
    const stmt = db.prepare('SELECT * FROM plans WHERE is_active = 1 AND (is_hidden IS NULL OR is_hidden = 0) ORDER BY price_monthly ASC');
    return stmt.all();
  }

  // Get all plans including hidden (for admin)
  static getAllForAdmin() {
    const stmt = db.prepare('SELECT * FROM plans WHERE is_active = 1 ORDER BY price_monthly ASC');
    return stmt.all();
  }

  // Get all plans with subscriber statistics (admin only - includes hidden plans)
  static getAllWithStats() {
    const stmt = db.prepare(`
      SELECT
        p.*,
        COUNT(u.id) as subscriber_count,
        COUNT(CASE WHEN u.subscription_status = 'active' THEN 1 END) as active_subscribers
      FROM plans p
      LEFT JOIN users u ON p.id = u.plan_id
      WHERE p.is_active = 1
      GROUP BY p.id
      ORDER BY p.price_monthly ASC
    `);
    return stmt.all();
  }

  // Get plan by ID
  static getById(id) {
    const stmt = db.prepare('SELECT * FROM plans WHERE id = ?');
    return stmt.get(id);
  }

  // Get plan by name
  static getByName(name) {
    const stmt = db.prepare('SELECT * FROM plans WHERE name = ?');
    return stmt.get(name);
  }

  // Create new plan (admin only)
  static create({
    name,
    description,
    price_monthly,
    price_yearly,
    max_concurrent_streams,
    max_bitrate,
    max_stream_duration,
    storage_limit_mb,
    custom_watermark,
    max_platform_connections
  }) {
    const stmt = db.prepare(`
      INSERT INTO plans (
        name, description, price_monthly, price_yearly,
        max_concurrent_streams, max_bitrate, max_stream_duration,
        storage_limit_mb, custom_watermark, max_platform_connections
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    const result = stmt.run(
      name,
      description || null,
      price_monthly,
      price_yearly,
      max_concurrent_streams,
      max_bitrate,
      max_stream_duration || null,
      storage_limit_mb,
      custom_watermark ? 1 : 0,
      max_platform_connections || 1
    );

    return this.getById(result.lastInsertRowid);
  }

  // Update plan (admin only)
  static update(id, data) {
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
      'is_hidden'
    ];

    allowedFields.forEach(field => {
      if (data[field] !== undefined) {
        fields.push(`${field} = ?`);
        if (field === 'custom_watermark' || field === 'is_active' || field === 'is_hidden') {
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

    stmt.run(...values);
    return this.getById(id);
  }

  // Delete plan (admin only) - soft delete by setting is_active = 0
  static delete(id) {
    // Check if any users are using this plan
    const usersCount = db.prepare('SELECT COUNT(*) as count FROM users WHERE plan_id = ?').get(id);

    if (usersCount.count > 0) {
      throw new Error(`Cannot delete plan: ${usersCount.count} user(s) are currently subscribed to this plan`);
    }

    const stmt = db.prepare('UPDATE plans SET is_active = 0, updated_at = CURRENT_TIMESTAMP WHERE id = ?');
    return stmt.run(id);
  }

  // Hard delete (use with caution)
  static hardDelete(id) {
    const stmt = db.prepare('DELETE FROM plans WHERE id = ?');
    return stmt.run(id);
  }

  // Get user count for each plan
  static getPlanStats() {
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
      WHERE p.is_active = 1
      GROUP BY p.id
      ORDER BY p.price_monthly ASC
    `);
    return stmt.all();
  }

  // Check if user can perform action based on plan limits
  static checkLimit(planId, limitType) {
    const plan = this.getById(planId);
    if (!plan) return null;

    const limits = {
      max_concurrent_streams: plan.max_concurrent_streams,
      max_bitrate: plan.max_bitrate,
      max_stream_duration: plan.max_stream_duration, // null = unlimited
      storage_limit_mb: plan.storage_limit_mb,
      custom_watermark: plan.custom_watermark === 1,
      max_platform_connections: plan.max_platform_connections || 1
    };

    return limits[limitType];
  }
}

export default Plan;
