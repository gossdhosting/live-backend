import db from './database.js';

class PaymentSettings {
  static async get() {
    const query = 'SELECT * FROM payment_settings WHERE id = $1';
    const result = await db.query(query, [1]);
    const settings = result.rows[0] || null;

    // Return active keys based on mode
    if (settings) {
      const mode = settings.mode || 'sandbox';
      settings.stripe_publishable_key = mode === 'sandbox'
        ? settings.stripe_publishable_key_sandbox
        : settings.stripe_publishable_key_live;
      settings.stripe_secret_key = mode === 'sandbox'
        ? settings.stripe_secret_key_sandbox
        : settings.stripe_secret_key_live;
      settings.stripe_webhook_secret = mode === 'sandbox'
        ? settings.stripe_webhook_secret_sandbox
        : settings.stripe_webhook_secret_live;
    }

    return settings;
  }

  static async update(data) {
    const {
      stripe_publishable_key_sandbox,
      stripe_secret_key_sandbox,
      stripe_webhook_secret_sandbox,
      stripe_publishable_key_live,
      stripe_secret_key_live,
      stripe_webhook_secret_live,
      mode,
    } = data;

    const query = `
      UPDATE payment_settings
      SET
        stripe_publishable_key_sandbox = COALESCE($1, stripe_publishable_key_sandbox),
        stripe_secret_key_sandbox = COALESCE($2, stripe_secret_key_sandbox),
        stripe_webhook_secret_sandbox = COALESCE($3, stripe_webhook_secret_sandbox),
        stripe_publishable_key_live = COALESCE($4, stripe_publishable_key_live),
        stripe_secret_key_live = COALESCE($5, stripe_secret_key_live),
        stripe_webhook_secret_live = COALESCE($6, stripe_webhook_secret_live),
        mode = COALESCE($7, mode),
        updated_at = CURRENT_TIMESTAMP
      WHERE id = 1
      RETURNING *
    `;

    const result = await db.query(query, [
      stripe_publishable_key_sandbox,
      stripe_secret_key_sandbox,
      stripe_webhook_secret_sandbox,
      stripe_publishable_key_live,
      stripe_secret_key_live,
      stripe_webhook_secret_live,
      mode,
    ]);

    const settings = result.rows[0];

    // Return active keys based on mode
    if (settings) {
      const activeMode = settings.mode || 'sandbox';
      settings.stripe_publishable_key = activeMode === 'sandbox'
        ? settings.stripe_publishable_key_sandbox
        : settings.stripe_publishable_key_live;
      settings.stripe_secret_key = activeMode === 'sandbox'
        ? settings.stripe_secret_key_sandbox
        : settings.stripe_secret_key_live;
      settings.stripe_webhook_secret = activeMode === 'sandbox'
        ? settings.stripe_webhook_secret_sandbox
        : settings.stripe_webhook_secret_live;
    }

    return settings;
  }

  static async getPublicSettings() {
    const query = 'SELECT stripe_publishable_key_sandbox, stripe_publishable_key_live, mode FROM payment_settings WHERE id = $1';
    const result = await db.query(query, [1]);
    const settings = result.rows[0] || { mode: 'sandbox' };

    // Return active publishable key based on mode
    const mode = settings.mode || 'sandbox';
    return {
      stripe_publishable_key: mode === 'sandbox'
        ? settings.stripe_publishable_key_sandbox
        : settings.stripe_publishable_key_live,
      mode: mode,
    };
  }

  static async isConfigured() {
    const settings = await this.get();
    return !!(settings && settings.stripe_secret_key && settings.stripe_publishable_key);
  }
}

export default PaymentSettings;
