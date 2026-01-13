import db from './database.js';

class StripeCustomer {
  static async create(userId, stripeCustomerId, email, mode = 'sandbox') {
    // Check if user already has a record
    const existing = await this.getByUserId(userId);

    if (existing) {
      // Update existing record with the appropriate customer ID based on mode
      const field = mode === 'sandbox' ? 'stripe_customer_id_sandbox' : 'stripe_customer_id_live';
      const query = `
        UPDATE stripe_customers
        SET ${field} = $2, stripe_customer_id = $2, email = $3
        WHERE user_id = $1
        RETURNING *
      `;
      const result = await db.query(query, [userId, stripeCustomerId, email]);
      return result.rows[0];
    } else {
      // Create new record
      const sandboxId = mode === 'sandbox' ? stripeCustomerId : null;
      const liveId = mode === 'live' ? stripeCustomerId : null;

      const query = `
        INSERT INTO stripe_customers (user_id, stripe_customer_id, stripe_customer_id_sandbox, stripe_customer_id_live, email)
        VALUES ($1, $2, $3, $4, $5)
        RETURNING *
      `;
      const result = await db.query(query, [userId, stripeCustomerId, sandboxId, liveId, email]);
      return result.rows[0];
    }
  }

  static async getByUserId(userId, mode = 'sandbox') {
    const query = 'SELECT * FROM stripe_customers WHERE user_id = $1';
    const result = await db.query(query, [userId]);
    const customer = result.rows[0];

    if (!customer) return null;

    // Set the appropriate stripe_customer_id based on mode
    customer.stripe_customer_id = mode === 'sandbox'
      ? customer.stripe_customer_id_sandbox
      : customer.stripe_customer_id_live;

    return customer;
  }

  static async getByStripeId(stripeCustomerId) {
    const query = `
      SELECT * FROM stripe_customers
      WHERE stripe_customer_id = $1
         OR stripe_customer_id_sandbox = $1
         OR stripe_customer_id_live = $1
    `;
    const result = await db.query(query, [stripeCustomerId]);
    return result.rows[0];
  }

  static async update(userId, stripeCustomerId, mode = 'sandbox') {
    const field = mode === 'sandbox' ? 'stripe_customer_id_sandbox' : 'stripe_customer_id_live';
    const query = `
      UPDATE stripe_customers
      SET ${field} = $2, stripe_customer_id = $2
      WHERE user_id = $1
      RETURNING *
    `;
    const result = await db.query(query, [userId, stripeCustomerId]);
    return result.rows[0];
  }

  static async delete(userId) {
    const query = 'DELETE FROM stripe_customers WHERE user_id = $1';
    await db.query(query, [userId]);
  }
}

export default StripeCustomer;
