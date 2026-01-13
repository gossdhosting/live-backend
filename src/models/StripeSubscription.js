import db from './database.js';

class StripeSubscription {
  static async create(data) {
    const {
      userId,
      stripeCustomerId,
      stripeSubscriptionId,
      stripePriceId,
      planId,
      status,
      billingCycle,
      currentPeriodStart,
      currentPeriodEnd,
    } = data;

    const query = `
      INSERT INTO stripe_subscriptions (
        user_id, stripe_customer_id, stripe_subscription_id, stripe_price_id,
        plan_id, status, billing_cycle, current_period_start, current_period_end
      )
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
      RETURNING *
    `;

    const result = await db.query(query, [
      userId,
      stripeCustomerId,
      stripeSubscriptionId,
      stripePriceId,
      planId,
      status,
      billingCycle,
      currentPeriodStart,
      currentPeriodEnd,
    ]);

    return result.rows[0];
  }

  static async getByUserId(userId) {
    const query = `
      SELECT ss.*, p.name as plan_name, p.description as plan_description
      FROM stripe_subscriptions ss
      LEFT JOIN plans p ON ss.plan_id = p.id
      WHERE ss.user_id = $1
      ORDER BY ss.created_at DESC
    `;
    const result = await db.query(query, [userId]);
    return result.rows;
  }

  static async getActiveByUserId(userId) {
    const query = `
      SELECT ss.*, p.name as plan_name
      FROM stripe_subscriptions ss
      LEFT JOIN plans p ON ss.plan_id = p.id
      WHERE ss.user_id = $1 AND ss.status IN ('active', 'trialing')
      ORDER BY ss.created_at DESC
      LIMIT 1
    `;
    const result = await db.query(query, [userId]);
    return result.rows[0];
  }

  static async getByStripeId(stripeSubscriptionId) {
    const query = 'SELECT * FROM stripe_subscriptions WHERE stripe_subscription_id = $1';
    const result = await db.query(query, [stripeSubscriptionId]);
    return result.rows[0];
  }

  static async getAll(limit = 100, offset = 0) {
    const query = `
      SELECT ss.*,
        u.email as user_email,
        u.name as user_name,
        p.name as plan_name,
        p.price_monthly,
        p.price_yearly
      FROM stripe_subscriptions ss
      LEFT JOIN users u ON ss.user_id = u.id
      LEFT JOIN plans p ON ss.plan_id = p.id
      ORDER BY ss.created_at DESC
      LIMIT $1 OFFSET $2
    `;
    const result = await db.query(query, [limit, offset]);
    return result.rows;
  }

  static async getStats() {
    const query = `
      SELECT
        COUNT(*) as total_subscriptions,
        COUNT(CASE WHEN status = 'active' THEN 1 END) as active_subscriptions,
        COUNT(CASE WHEN status = 'canceled' THEN 1 END) as canceled_subscriptions,
        COUNT(CASE WHEN status = 'past_due' THEN 1 END) as past_due_subscriptions,
        SUM(CASE
          WHEN status = 'active' AND billing_cycle = 'monthly' THEN
            (SELECT price_monthly FROM plans WHERE id = plan_id)
          WHEN status = 'active' AND billing_cycle = 'yearly' THEN
            (SELECT price_yearly FROM plans WHERE id = plan_id) / 12
          ELSE 0
        END) as monthly_recurring_revenue
      FROM stripe_subscriptions
    `;
    const result = await db.query(query);
    return result.rows[0];
  }

  static async update(stripeSubscriptionId, data) {
    const fields = [];
    const values = [];
    let paramCount = 1;

    Object.keys(data).forEach((key) => {
      const snakeKey = key.replace(/[A-Z]/g, (letter) => `_${letter.toLowerCase()}`);
      fields.push(`${snakeKey} = $${paramCount}`);
      values.push(data[key]);
      paramCount++;
    });

    if (fields.length === 0) return null;

    const query = `
      UPDATE stripe_subscriptions
      SET ${fields.join(', ')}, updated_at = CURRENT_TIMESTAMP
      WHERE stripe_subscription_id = $${paramCount}
      RETURNING *
    `;

    values.push(stripeSubscriptionId);
    const result = await db.query(query, values);
    return result.rows[0];
  }

  static async updatePlan(subscriptionId, planId, billingCycle, stripePriceId) {
    const query = `
      UPDATE stripe_subscriptions
      SET plan_id = $2, billing_cycle = $3, stripe_price_id = $4, updated_at = CURRENT_TIMESTAMP
      WHERE id = $1
      RETURNING *
    `;
    const result = await db.query(query, [subscriptionId, planId, billingCycle, stripePriceId]);
    return result.rows[0];
  }

  static async cancel(stripeSubscriptionId, cancelAtPeriodEnd = true) {
    const query = `
      UPDATE stripe_subscriptions
      SET
        cancel_at_period_end = $1,
        canceled_at = CASE WHEN $1 = FALSE THEN CURRENT_TIMESTAMP ELSE canceled_at END,
        status = CASE WHEN $1 = FALSE THEN 'canceled' ELSE status END,
        updated_at = CURRENT_TIMESTAMP
      WHERE stripe_subscription_id = $2
      RETURNING *
    `;
    const result = await db.query(query, [cancelAtPeriodEnd, stripeSubscriptionId]);
    return result.rows[0];
  }

  static async delete(stripeSubscriptionId) {
    const query = 'DELETE FROM stripe_subscriptions WHERE stripe_subscription_id = $1';
    await db.query(query, [stripeSubscriptionId]);
  }
}

export default StripeSubscription;
