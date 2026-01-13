import db from './database.js';

class StripeCustomer {
  static async create(userId, stripeCustomerId, email) {
    const query = `
      INSERT INTO stripe_customers (user_id, stripe_customer_id, email)
      VALUES ($1, $2, $3)
      RETURNING *
    `;
    const result = await db.query(query, [userId, stripeCustomerId, email]);
    return result.rows[0];
  }

  static async getByUserId(userId) {
    const query = 'SELECT * FROM stripe_customers WHERE user_id = $1';
    const result = await db.query(query, [userId]);
    return result.rows[0];
  }

  static async getByStripeId(stripeCustomerId) {
    const query = 'SELECT * FROM stripe_customers WHERE stripe_customer_id = $1';
    const result = await db.query(query, [stripeCustomerId]);
    return result.rows[0];
  }

  static async update(userId, stripeCustomerId) {
    const query = `
      UPDATE stripe_customers
      SET stripe_customer_id = $2
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
