import Stripe from 'stripe';
import PaymentSettings from '../models/PaymentSettings.js';
import logger from '../utils/logger.js';

class StripeConfig {
  constructor() {
    this.stripe = null;
    this.webhookSecret = null;
    this.mode = 'sandbox';
  }

  async initialize() {
    try {
      const settings = await PaymentSettings.get();

      if (!settings || !settings.stripe_secret_key) {
        logger.warn('Stripe: No API keys configured. Payment processing disabled.');
        return false;
      }

      this.stripe = new Stripe(settings.stripe_secret_key, {
        apiVersion: '2024-12-18.acacia',
      });

      this.webhookSecret = settings.stripe_webhook_secret;
      this.mode = settings.mode || 'sandbox';

      logger.info(`Stripe: Initialized in ${this.mode} mode`);
      return true;
    } catch (error) {
      logger.error('Stripe: Failed to initialize', { error: error.message });
      return false;
    }
  }

  async reinitialize() {
    return await this.initialize();
  }

  getStripe() {
    if (!this.stripe) {
      throw new Error('Stripe not initialized. Please configure payment settings.');
    }
    return this.stripe;
  }

  getWebhookSecret() {
    return this.webhookSecret;
  }

  getMode() {
    return this.mode;
  }

  isConfigured() {
    return this.stripe !== null;
  }
}

// Singleton instance
const stripeConfig = new StripeConfig();

export default stripeConfig;
