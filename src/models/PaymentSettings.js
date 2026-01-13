import db from '../config/database.js';

class PaymentSettings {
  static async get() {
    const query = 'SELECT * FROM payment_settings WHERE id = $1';
    const result = await db.query(query, [1]);
    return result.rows[0] || null;
  }

  static async update(data) {
    const {
      stripe_publishable_key,
      stripe_secret_key,
      stripe_webhook_secret,
      mode,
    } = data;

    const query = `
      UPDATE payment_settings
      SET
        stripe_publishable_key = COALESCE($1, stripe_publishable_key),
        stripe_secret_key = COALESCE($2, stripe_secret_key),
        stripe_webhook_secret = COALESCE($3, stripe_webhook_secret),
        mode = COALESCE($4, mode),
        updated_at = CURRENT_TIMESTAMP
      WHERE id = 1
      RETURNING *
    `;

    const result = await db.query(query, [
      stripe_publishable_key,
      stripe_secret_key,
      stripe_webhook_secret,
      mode,
    ]);

    return result.rows[0];
  }

  static async getPublicSettings() {
    const query = 'SELECT stripe_publishable_key, mode FROM payment_settings WHERE id = $1';
    const result = await db.query(query, [1]);
    return result.rows[0] || { stripe_publishable_key: null, mode: 'sandbox' };
  }

  static async isConfigured() {
    const settings = await this.get();
    return !!(settings && settings.stripe_secret_key && settings.stripe_publishable_key);
  }
}

export default PaymentSettings;
