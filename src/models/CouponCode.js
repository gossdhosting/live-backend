import db from './database.js';
import logger from '../utils/logger.js';

class CouponCode {
  // Create a new coupon code
  static async create(data) {
    const {
      code,
      stripeCouponId,
      discountType,
      discountValue,
      duration,
      durationMonths,
      maxRedemptions,
      validFrom,
      validUntil,
    } = data;

    const query = `
      INSERT INTO coupon_codes (
        code, stripe_coupon_id, discount_type, discount_value,
        duration, duration_months, max_redemptions, valid_from, valid_until
      )
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
      RETURNING *
    `;

    try {
      const result = await db.query(query, [
        code.toUpperCase(),
        stripeCouponId,
        discountType,
        discountValue,
        duration,
        durationMonths,
        maxRedemptions,
        validFrom || new Date(),
        validUntil,
      ]);

      logger.info('Coupon code created', { code });
      return result.rows[0];
    } catch (error) {
      logger.error('Failed to create coupon code', { error: error.message, code });
      throw error;
    }
  }

  // Get coupon by code
  static async getByCode(code) {
    const query = 'SELECT * FROM coupon_codes WHERE code = $1';
    const result = await db.query(query, [code.toUpperCase()]);
    return result.rows[0] || null;
  }

  // Get coupon by ID
  static async getById(id) {
    const query = 'SELECT * FROM coupon_codes WHERE id = $1';
    const result = await db.query(query, [id]);
    return result.rows[0] || null;
  }

  // Get all coupons (for admin)
  static async getAll() {
    const query = `
      SELECT
        c.*,
        COUNT(cr.id) as total_redemptions
      FROM coupon_codes c
      LEFT JOIN coupon_redemptions cr ON c.id = cr.coupon_id
      GROUP BY c.id
      ORDER BY c.created_at DESC
    `;
    const result = await db.query(query);
    return result.rows;
  }

  // Validate coupon code
  static async validateCoupon(code, userId = null) {
    const coupon = await this.getByCode(code);

    if (!coupon) {
      return { valid: false, error: 'Coupon code not found' };
    }

    if (!coupon.is_active) {
      return { valid: false, error: 'Coupon code is inactive' };
    }

    // Check validity dates
    const now = new Date();
    if (coupon.valid_from && new Date(coupon.valid_from) > now) {
      return { valid: false, error: 'Coupon code is not yet valid' };
    }

    if (coupon.valid_until && new Date(coupon.valid_until) < now) {
      return { valid: false, error: 'Coupon code has expired' };
    }

    // Check max redemptions
    if (coupon.max_redemptions && coupon.times_redeemed >= coupon.max_redemptions) {
      return { valid: false, error: 'Coupon code has reached maximum redemptions' };
    }

    // Check if user already redeemed (if userId provided)
    if (userId) {
      const redemptionQuery = 'SELECT id FROM coupon_redemptions WHERE coupon_id = $1 AND user_id = $2';
      const redemptionResult = await db.query(redemptionQuery, [coupon.id, userId]);
      if (redemptionResult.rows.length > 0) {
        return { valid: false, error: 'You have already used this coupon code' };
      }
    }

    return { valid: true, coupon };
  }

  // Increment redemption count
  static async incrementRedemptions(couponId) {
    const query = `
      UPDATE coupon_codes
      SET times_redeemed = times_redeemed + 1,
          updated_at = CURRENT_TIMESTAMP
      WHERE id = $1
      RETURNING *
    `;
    const result = await db.query(query, [couponId]);
    return result.rows[0];
  }

  // Record coupon redemption
  static async recordRedemption(couponId, userId, stripeSubscriptionId) {
    const query = `
      INSERT INTO coupon_redemptions (coupon_id, user_id, stripe_subscription_id)
      VALUES ($1, $2, $3)
      RETURNING *
    `;

    try {
      const result = await db.query(query, [couponId, userId, stripeSubscriptionId]);
      await this.incrementRedemptions(couponId);
      logger.info('Coupon redemption recorded', { couponId, userId });
      return result.rows[0];
    } catch (error) {
      logger.error('Failed to record coupon redemption', { error: error.message });
      throw error;
    }
  }

  // Update coupon
  static async update(id, data) {
    const {
      code,
      discountType,
      discountValue,
      duration,
      durationMonths,
      maxRedemptions,
      validFrom,
      validUntil,
      isActive,
    } = data;

    const query = `
      UPDATE coupon_codes
      SET
        code = COALESCE($1, code),
        discount_type = COALESCE($2, discount_type),
        discount_value = COALESCE($3, discount_value),
        duration = COALESCE($4, duration),
        duration_months = COALESCE($5, duration_months),
        max_redemptions = COALESCE($6, max_redemptions),
        valid_from = COALESCE($7, valid_from),
        valid_until = COALESCE($8, valid_until),
        is_active = COALESCE($9, is_active),
        updated_at = CURRENT_TIMESTAMP
      WHERE id = $10
      RETURNING *
    `;

    try {
      const result = await db.query(query, [
        code ? code.toUpperCase() : null,
        discountType,
        discountValue,
        duration,
        durationMonths,
        maxRedemptions,
        validFrom,
        validUntil,
        isActive,
        id,
      ]);

      logger.info('Coupon code updated', { id });
      return result.rows[0];
    } catch (error) {
      logger.error('Failed to update coupon code', { error: error.message, id });
      throw error;
    }
  }

  // Delete coupon
  static async delete(id) {
    const query = 'DELETE FROM coupon_codes WHERE id = $1 RETURNING *';
    try {
      const result = await db.query(query, [id]);
      logger.info('Coupon code deleted', { id });
      return result.rows[0];
    } catch (error) {
      logger.error('Failed to delete coupon code', { error: error.message, id });
      throw error;
    }
  }

  // Get redemption history for a coupon
  static async getRedemptionHistory(couponId) {
    const query = `
      SELECT
        cr.*,
        u.email as user_email,
        u.name as user_name
      FROM coupon_redemptions cr
      JOIN users u ON cr.user_id = u.id
      WHERE cr.coupon_id = $1
      ORDER BY cr.redeemed_at DESC
    `;
    const result = await db.query(query, [couponId]);
    return result.rows;
  }
}

export default CouponCode;
