import stripeConfig from '../config/stripe.js';
import PaymentSettings from '../models/PaymentSettings.js';
import StripeCustomer from '../models/StripeCustomer.js';
import StripeSubscription from '../models/StripeSubscription.js';
import Invoice from '../models/Invoice.js';
import Plan from '../models/Plan.js';
import User from '../models/User.js';
import CouponCode from '../models/CouponCode.js';
import PdfService from '../services/PdfService.js';
import logger from '../utils/logger.js';
import path from 'path';
import { sendSubscriptionEmail } from '../services/EmailService.js';

// Create Stripe Checkout Session
export async function createCheckoutSession(req, res) {
  try {
    const userId = req.user.id;
    const { planId, billingCycle, couponCode } = req.body; // billingCycle: 'monthly' or 'yearly'

    if (!planId || !billingCycle) {
      return res.status(400).json({ error: 'Plan ID and billing cycle are required' });
    }

    if (!['monthly', 'yearly'].includes(billingCycle)) {
      return res.status(400).json({ error: 'Invalid billing cycle. Must be monthly or yearly' });
    }

    // Get plan details
    const plan = await Plan.getById(planId);
    if (!plan) {
      return res.status(404).json({ error: 'Plan not found' });
    }

    // Calculate amount based on billing cycle
    const amount = billingCycle === 'monthly'
      ? parseFloat(plan.price_monthly)
      : parseFloat(plan.price_yearly);

    if (amount <= 0) {
      return res.status(400).json({
        error: 'This plan does not have a valid price configured for the selected billing cycle.',
      });
    }

    const stripe = stripeConfig.getStripe();
    const mode = stripeConfig.getMode();
    const user = await User.getById(userId);

    // Validate coupon if provided
    let stripeCouponId = null;
    let couponId = null;
    if (couponCode) {
      const validation = await CouponCode.validateCoupon(couponCode, userId);
      if (!validation.valid) {
        return res.status(400).json({ error: validation.error });
      }
      stripeCouponId = validation.coupon.stripe_coupon_id;
      couponId = validation.coupon.id;
    }

    // Get or create Stripe customer for the current mode (sandbox or live)
    let stripeCustomer = await StripeCustomer.getByUserId(userId, mode);
    let customerId;

    if (stripeCustomer && stripeCustomer.stripe_customer_id) {
      customerId = stripeCustomer.stripe_customer_id;
    } else {
      const customer = await stripe.customers.create({
        email: user.email,
        metadata: {
          userId: userId.toString(),
          mode: mode,
        },
      });
      customerId = customer.id;
      await StripeCustomer.create(userId, customerId, user.email, mode);
    }

    // Create checkout session with subscription using price_data (dynamic pricing)
    const sessionConfig = {
      customer: customerId,
      payment_method_types: ['card'],
      line_items: [
        {
          price_data: {
            currency: 'usd',
            product_data: {
              name: `${plan.name} Plan`,
              description: `${plan.description || plan.name} - ${billingCycle === 'monthly' ? 'Monthly' : 'Yearly'} billing`,
            },
            unit_amount: Math.round(amount * 100), // Convert to cents
            recurring: {
              interval: billingCycle === 'monthly' ? 'month' : 'year',
              interval_count: 1,
            },
          },
          quantity: 1,
        },
      ],
      mode: 'subscription',
      success_url: `${process.env.FRONTEND_URL}/plans?session_id={CHECKOUT_SESSION_ID}&success=true`,
      cancel_url: `${process.env.FRONTEND_URL}/plans?canceled=true`,
      metadata: {
        userId: userId.toString(),
        planId: planId.toString(),
        billingCycle,
        ...(couponId && { couponId: couponId.toString() }),
      },
      subscription_data: {
        metadata: {
          userId: userId.toString(),
          planId: planId.toString(),
          billingCycle,
          ...(couponId && { couponId: couponId.toString() }),
        },
      },
    };

    // Add coupon if provided
    if (stripeCouponId) {
      sessionConfig.discounts = [{ coupon: stripeCouponId }];
    }

    const session = await stripe.checkout.sessions.create(sessionConfig);

    logger.info('Stripe: Checkout session created', {
      userId,
      planId,
      sessionId: session.id,
      withCoupon: !!stripeCouponId,
    });

    res.json({
      sessionId: session.id,
      url: session.url,
    });
  } catch (error) {
    logger.error('Stripe: Failed to create checkout session', {
      error: error.message,
    });
    res.status(500).json({ error: error.message || 'Failed to create checkout session' });
  }
}

// Get customer portal URL
export async function createPortalSession(req, res) {
  try {
    const userId = req.user.id;

    const stripeCustomer = await StripeCustomer.getByUserId(userId);
    if (!stripeCustomer) {
      return res.status(404).json({ error: 'No subscription found' });
    }

    const stripe = stripeConfig.getStripe();
    const session = await stripe.billingPortal.sessions.create({
      customer: stripeCustomer.stripe_customer_id,
      return_url: `${process.env.FRONTEND_URL}/profile`,
    });

    res.json({ url: session.url });
  } catch (error) {
    logger.error('Stripe: Failed to create portal session', {
      error: error.message,
    });
    res.status(500).json({ error: 'Failed to create portal session' });
  }
}

// Get user's subscription details
export async function getSubscription(req, res) {
  try {
    const userId = req.user.id;

    const subscription = await StripeSubscription.getActiveByUserId(userId);
    if (!subscription) {
      return res.json({ subscription: null });
    }

    res.json({ subscription });
  } catch (error) {
    logger.error('Stripe: Failed to get subscription', {
      error: error.message,
    });
    res.status(500).json({ error: 'Failed to get subscription' });
  }
}

// Get user's invoices
export async function getInvoices(req, res) {
  try {
    const userId = req.user.id;
    const limit = parseInt(req.query.limit) || 50;

    const invoices = await Invoice.getByUserId(userId, limit);
    res.json({ invoices });
  } catch (error) {
    logger.error('Stripe: Failed to get invoices', {
      error: error.message,
    });
    res.status(500).json({ error: 'Failed to get invoices' });
  }
}

// Cancel subscription
export async function cancelSubscription(req, res) {
  try {
    const userId = req.user.id;
    const { cancelAtPeriodEnd = true } = req.body;

    const subscription = await StripeSubscription.getActiveByUserId(userId);
    if (!subscription) {
      return res.status(404).json({ error: 'No active subscription found' });
    }

    const stripe = stripeConfig.getStripe();

    if (cancelAtPeriodEnd) {
      // Cancel at period end
      await stripe.subscriptions.update(subscription.stripe_subscription_id, {
        cancel_at_period_end: true,
      });
    } else {
      // Cancel immediately
      await stripe.subscriptions.cancel(subscription.stripe_subscription_id);
    }

    await StripeSubscription.cancel(subscription.stripe_subscription_id, cancelAtPeriodEnd);

    logger.info('Stripe: Subscription canceled', {
      userId,
      subscriptionId: subscription.stripe_subscription_id,
      immediate: !cancelAtPeriodEnd,
    });

    res.json({
      message: cancelAtPeriodEnd
        ? 'Subscription will be canceled at the end of the billing period'
        : 'Subscription canceled immediately',
    });
  } catch (error) {
    logger.error('Stripe: Failed to cancel subscription', {
      error: error.message,
    });
    res.status(500).json({ error: 'Failed to cancel subscription' });
  }
}

// ADMIN: Get all subscriptions
export async function getAllSubscriptions(req, res) {
  try {
    const limit = parseInt(req.query.limit) || 100;
    const offset = parseInt(req.query.offset) || 0;

    const subscriptions = await StripeSubscription.getAll(limit, offset);
    const stats = await StripeSubscription.getStats();

    res.json({ subscriptions, stats });
  } catch (error) {
    logger.error('Stripe: Failed to get all subscriptions', {
      error: error.message,
      stack: error.stack,
    });
    res.status(500).json({ error: 'Failed to get subscriptions', details: error.message });
  }
}

// ADMIN: Get all invoices
export async function getAllInvoices(req, res) {
  try {
    const limit = parseInt(req.query.limit) || 100;
    const offset = parseInt(req.query.offset) || 0;

    const invoices = await Invoice.getAll(limit, offset);
    const revenue = await Invoice.getTotalRevenue();

    res.json({ invoices, revenue });
  } catch (error) {
    logger.error('Stripe: Failed to get all invoices', {
      error: error.message,
      stack: error.stack,
    });
    res.status(500).json({ error: 'Failed to get invoices', details: error.message });
  }
}

// ADMIN: Cancel any user's subscription
export async function adminCancelSubscription(req, res) {
  try {
    const { subscriptionId } = req.params;
    const { cancelAtPeriodEnd = false } = req.body;

    const subscription = await StripeSubscription.getByStripeId(subscriptionId);
    if (!subscription) {
      return res.status(404).json({ error: 'Subscription not found' });
    }

    const stripe = stripeConfig.getStripe();

    if (cancelAtPeriodEnd) {
      await stripe.subscriptions.update(subscriptionId, {
        cancel_at_period_end: true,
      });
    } else {
      await stripe.subscriptions.cancel(subscriptionId);
    }

    await StripeSubscription.cancel(subscriptionId, cancelAtPeriodEnd);

    logger.info('Stripe: Admin canceled subscription', {
      subscriptionId,
      immediate: !cancelAtPeriodEnd,
    });

    res.json({ message: 'Subscription canceled' });
  } catch (error) {
    logger.error('Stripe: Failed to admin cancel subscription', {
      error: error.message,
    });
    res.status(500).json({ error: 'Failed to cancel subscription' });
  }
}

// ADMIN: Get payment settings
export async function getPaymentSettings(req, res) {
  try {
    // Get raw settings with both sandbox and live keys
    const query = 'SELECT * FROM payment_settings WHERE id = $1';
    const db = (await import('../models/database.js')).default;
    const result = await db.query(query, [1]);
    const settings = result.rows[0] || {};

    // Mask secret keys for security while showing they exist
    if (settings) {
      // Sandbox keys
      if (settings.stripe_secret_key_sandbox) {
        settings.stripe_secret_key_sandbox = settings.stripe_secret_key_sandbox.substring(0, 7) + '••••••••••••••••••••••••••••';
      }
      if (settings.stripe_webhook_secret_sandbox) {
        settings.stripe_webhook_secret_sandbox = settings.stripe_webhook_secret_sandbox.substring(0, 7) + '••••••••••••••••••••••••••••';
      }

      // Live keys
      if (settings.stripe_secret_key_live) {
        settings.stripe_secret_key_live = settings.stripe_secret_key_live.substring(0, 7) + '••••••••••••••••••••••••••••';
      }
      if (settings.stripe_webhook_secret_live) {
        settings.stripe_webhook_secret_live = settings.stripe_webhook_secret_live.substring(0, 7) + '••••••••••••••••••••••••••••';
      }
    }
    res.json({ settings: settings || {} });
  } catch (error) {
    logger.error('Stripe: Failed to get payment settings', {
      error: error.message,
      stack: error.stack,
    });
    res.status(500).json({ error: 'Failed to get payment settings', details: error.message });
  }
}

// ADMIN: Update payment settings
export async function updatePaymentSettings(req, res) {
  try {
    let {
      stripe_publishable_key_sandbox,
      stripe_secret_key_sandbox,
      stripe_webhook_secret_sandbox,
      stripe_publishable_key_live,
      stripe_secret_key_live,
      stripe_webhook_secret_live,
      mode,
    } = req.body;

    // Don't update with masked values - treat them as unchanged
    // Also convert undefined to null for COALESCE to work properly
    if (stripe_secret_key_sandbox === undefined || (stripe_secret_key_sandbox && stripe_secret_key_sandbox.includes('••••'))) {
      stripe_secret_key_sandbox = null;
    }
    if (stripe_webhook_secret_sandbox === undefined || (stripe_webhook_secret_sandbox && stripe_webhook_secret_sandbox.includes('••••'))) {
      stripe_webhook_secret_sandbox = null;
    }
    if (stripe_secret_key_live === undefined || (stripe_secret_key_live && stripe_secret_key_live.includes('••••'))) {
      stripe_secret_key_live = null;
    }
    if (stripe_webhook_secret_live === undefined || (stripe_webhook_secret_live && stripe_webhook_secret_live.includes('••••'))) {
      stripe_webhook_secret_live = null;
    }

    // For publishable keys, convert undefined to null as well
    if (stripe_publishable_key_sandbox === undefined) {
      stripe_publishable_key_sandbox = null;
    }
    if (stripe_publishable_key_live === undefined) {
      stripe_publishable_key_live = null;
    }

    // Validate sandbox keys if provided
    if (stripe_secret_key_sandbox && !stripe_secret_key_sandbox.startsWith('sk_test_')) {
      return res.status(400).json({
        error: 'Invalid sandbox secret key',
        details: 'Sandbox secret key must start with sk_test_',
      });
    }
    if (stripe_publishable_key_sandbox && !stripe_publishable_key_sandbox.startsWith('pk_test_')) {
      return res.status(400).json({
        error: 'Invalid sandbox publishable key',
        details: 'Sandbox publishable key must start with pk_test_',
      });
    }

    // Validate live keys if provided
    if (stripe_secret_key_live && !stripe_secret_key_live.startsWith('sk_live_')) {
      return res.status(400).json({
        error: 'Invalid live secret key',
        details: 'Live secret key must start with sk_live_',
      });
    }
    if (stripe_publishable_key_live && !stripe_publishable_key_live.startsWith('pk_live_')) {
      return res.status(400).json({
        error: 'Invalid live publishable key',
        details: 'Live publishable key must start with pk_live_',
      });
    }

    const settings = await PaymentSettings.update({
      stripe_publishable_key_sandbox,
      stripe_secret_key_sandbox,
      stripe_webhook_secret_sandbox,
      stripe_publishable_key_live,
      stripe_secret_key_live,
      stripe_webhook_secret_live,
      mode,
    });

    // Reinitialize Stripe with new settings
    await stripeConfig.reinitialize();

    // Get raw settings again to mask secrets
    const db = (await import('../models/database.js')).default;
    const query = 'SELECT * FROM payment_settings WHERE id = $1';
    const result = await db.query(query, [1]);
    const maskedSettings = result.rows[0] || {};

    // Mask all secret keys
    if (maskedSettings.stripe_secret_key_sandbox) {
      maskedSettings.stripe_secret_key_sandbox = maskedSettings.stripe_secret_key_sandbox.substring(0, 7) + '••••••••••••••••••••••••••••';
    }
    if (maskedSettings.stripe_webhook_secret_sandbox) {
      maskedSettings.stripe_webhook_secret_sandbox = maskedSettings.stripe_webhook_secret_sandbox.substring(0, 7) + '••••••••••••••••••••••••••••';
    }
    if (maskedSettings.stripe_secret_key_live) {
      maskedSettings.stripe_secret_key_live = maskedSettings.stripe_secret_key_live.substring(0, 7) + '••••••••••••••••••••••••••••';
    }
    if (maskedSettings.stripe_webhook_secret_live) {
      maskedSettings.stripe_webhook_secret_live = maskedSettings.stripe_webhook_secret_live.substring(0, 7) + '••••••••••••••••••••••••••••';
    }

    logger.info('Stripe: Payment settings updated', { mode: maskedSettings.mode });

    res.json({ settings: maskedSettings, message: 'Payment settings updated successfully' });
  } catch (error) {
    logger.error('Stripe: Failed to update payment settings', {
      error: error.message,
      stack: error.stack,
    });
    res.status(500).json({ error: 'Failed to update payment settings', details: error.message });
  }
}

// Get public payment settings (for frontend)
export async function getPublicSettings(req, res) {
  try {
    const settings = await PaymentSettings.getPublicSettings();
    res.json({ settings });
  } catch (error) {
    logger.error('Stripe: Failed to get public settings', {
      error: error.message,
    });
    res.status(500).json({ error: 'Failed to get public settings' });
  }
}

// ADMIN: Sync Stripe products and prices to plans
export async function syncStripePrices(req, res) {
  try {
    const { planId, stripePriceIdMonthly, stripePriceIdYearly, stripeProductId } = req.body;

    if (!planId) {
      return res.status(400).json({ error: 'Plan ID is required' });
    }

    const plan = await Plan.getById(planId);
    if (!plan) {
      return res.status(404).json({ error: 'Plan not found' });
    }

    // Update plan with Stripe IDs
    const updated = await Plan.update(planId, {
      stripe_price_id_monthly: stripePriceIdMonthly,
      stripe_price_id_yearly: stripePriceIdYearly,
      stripe_product_id: stripeProductId,
    });

    logger.info('Stripe: Plan prices synced', { planId });

    res.json({ plan: updated, message: 'Stripe prices synced successfully' });
  } catch (error) {
    logger.error('Stripe: Failed to sync prices', {
      error: error.message,
    });
    res.status(500).json({ error: 'Failed to sync prices' });
  }
}

// Validate coupon code (user endpoint)
export async function validateCoupon(req, res) {
  try {
    const { code } = req.body;
    const userId = req.user.id;

    if (!code) {
      return res.status(400).json({ error: 'Coupon code is required' });
    }

    const validation = await CouponCode.validateCoupon(code, userId);

    if (!validation.valid) {
      return res.status(400).json({ valid: false, error: validation.error });
    }

    // Return coupon details without sensitive info
    res.json({
      valid: true,
      coupon: {
        code: validation.coupon.code,
        discount_type: validation.coupon.discount_type,
        discount_value: validation.coupon.discount_value,
        duration: validation.coupon.duration,
      },
    });
  } catch (error) {
    logger.error('Failed to validate coupon', { error: error.message });
    res.status(500).json({ error: 'Failed to validate coupon' });
  }
}

// ADMIN: Get all coupons
export async function getAllCoupons(req, res) {
  try {
    const coupons = await CouponCode.getAll();
    res.json({ coupons });
  } catch (error) {
    logger.error('Failed to get coupons', { error: error.message });
    res.status(500).json({ error: 'Failed to get coupons' });
  }
}

// ADMIN: Create coupon
export async function createCoupon(req, res) {
  try {
    const {
      code,
      discountType,
      discountValue,
      duration,
      durationMonths,
      maxRedemptions,
      validFrom,
      validUntil,
    } = req.body;

    if (!code || !discountType || !discountValue || !duration) {
      return res.status(400).json({
        error: 'Code, discount type, discount value, and duration are required',
      });
    }

    // Create coupon in Stripe first
    const stripe = stripeConfig.getStripe();
    const stripeCouponData = {
      id: code.toUpperCase().replace(/\s+/g, ''),
      name: code.toUpperCase(),
      duration: duration,
    };

    if (discountType === 'percentage') {
      stripeCouponData.percent_off = parseFloat(discountValue);
    } else {
      stripeCouponData.amount_off = Math.round(parseFloat(discountValue) * 100); // Convert to cents
      stripeCouponData.currency = 'usd';
    }

    if (duration === 'repeating' && durationMonths) {
      stripeCouponData.duration_in_months = parseInt(durationMonths);
    }

    const stripeCoupon = await stripe.coupons.create(stripeCouponData);

    // Create in database
    const coupon = await CouponCode.create({
      code,
      stripeCouponId: stripeCoupon.id,
      discountType,
      discountValue,
      duration,
      durationMonths,
      maxRedemptions,
      validFrom,
      validUntil,
    });

    logger.info('Coupon created', { code: coupon.code });

    res.json({ coupon, message: 'Coupon created successfully' });
  } catch (error) {
    logger.error('Failed to create coupon', { error: error.message });
    res.status(500).json({ error: error.message || 'Failed to create coupon' });
  }
}

// ADMIN: Update coupon
export async function updateCoupon(req, res) {
  try {
    const { id } = req.params;
    const { maxRedemptions, validFrom, validUntil, isActive } = req.body;

    const coupon = await CouponCode.update(id, {
      maxRedemptions,
      validFrom,
      validUntil,
      isActive,
    });

    if (!coupon) {
      return res.status(404).json({ error: 'Coupon not found' });
    }

    logger.info('Coupon updated', { id });

    res.json({ coupon, message: 'Coupon updated successfully' });
  } catch (error) {
    logger.error('Failed to update coupon', { error: error.message });
    res.status(500).json({ error: 'Failed to update coupon' });
  }
}

// ADMIN: Delete coupon
export async function deleteCoupon(req, res) {
  try {
    const { id } = req.params;

    const coupon = await CouponCode.getById(id);
    if (!coupon) {
      return res.status(404).json({ error: 'Coupon not found' });
    }

    // Delete from Stripe if it exists
    if (coupon.stripe_coupon_id) {
      try {
        const stripe = stripeConfig.getStripe();
        await stripe.coupons.del(coupon.stripe_coupon_id);
      } catch (error) {
        logger.warn('Failed to delete coupon from Stripe', {
          error: error.message,
          stripeCouponId: coupon.stripe_coupon_id,
        });
      }
    }

    // Delete from database
    await CouponCode.delete(id);

    logger.info('Coupon deleted', { id });

    res.json({ message: 'Coupon deleted successfully' });
  } catch (error) {
    logger.error('Failed to delete coupon', { error: error.message });
    res.status(500).json({ error: 'Failed to delete coupon' });
  }
}

// ADMIN: Get coupon redemption history
export async function getCouponRedemptions(req, res) {
  try {
    const { id } = req.params;

    const redemptions = await CouponCode.getRedemptionHistory(id);

    res.json({ redemptions });
  } catch (error) {
    logger.error('Failed to get coupon redemptions', { error: error.message });
    res.status(500).json({ error: 'Failed to get coupon redemptions' });
  }
}

// Preview upgrade cost with proration
export async function previewUpgrade(req, res) {
  try {
    const userId = req.user.id;
    const { newPlanId, billingCycle } = req.query;

    if (!newPlanId || !billingCycle) {
      return res.status(400).json({ error: 'New plan ID and billing cycle are required' });
    }

    // Get current subscription
    const currentSubscription = await StripeSubscription.getActiveByUserId(userId);
    if (!currentSubscription) {
      return res.status(404).json({ error: 'No active subscription found' });
    }

    // Get new plan details
    const newPlan = await Plan.getById(newPlanId);
    if (!newPlan) {
      return res.status(404).json({ error: 'Plan not found' });
    }

    // Calculate new amount
    const newAmount = billingCycle === 'monthly'
      ? parseFloat(newPlan.price_monthly)
      : parseFloat(newPlan.price_yearly);

    if (newAmount <= 0) {
      return res.status(400).json({ error: 'Plan not configured for this billing cycle' });
    }

    const stripe = stripeConfig.getStripe();

    // Get current subscription from Stripe
    const stripeSubscription = await stripe.subscriptions.retrieve(
      currentSubscription.stripe_subscription_id
    );

    // Get current plan details for proration calculation
    const currentPlan = await Plan.getById(currentSubscription.plan_id);
    const currentAmount = currentSubscription.billing_cycle === 'monthly'
      ? parseFloat(currentPlan.price_monthly)
      : parseFloat(currentPlan.price_yearly);

    // Calculate proration manually
    const now = Math.floor(Date.now() / 1000);
    const periodStart = stripeSubscription.current_period_start;
    const periodEnd = stripeSubscription.current_period_end;
    const totalDuration = periodEnd - periodStart;
    const remainingDuration = periodEnd - now;
    const usedDuration = now - periodStart;

    // Calculate unused time credit from current plan
    const unusedCredit = (currentAmount * remainingDuration) / totalDuration;

    // Calculate charge for new plan for remaining period
    const newPlanCharge = (newAmount * remainingDuration) / totalDuration;

    // Net amount due (new plan charge - unused credit)
    const proratedAmount = Math.max(0, newPlanCharge - unusedCredit);

    res.json({
      newPlan: {
        id: newPlan.id,
        name: newPlan.name,
        price: newAmount,
      },
      currentPlan: {
        id: currentSubscription.plan_id,
        billingCycle: currentSubscription.billing_cycle,
        price: currentAmount,
      },
      proration: {
        dueNow: proratedAmount,
        fullPrice: newAmount,
        credit: unusedCredit,
        newPlanCharge: newPlanCharge,
        remainingDays: Math.ceil(remainingDuration / 86400),
        currency: 'USD',
      },
      nextBillingDate: new Date(stripeSubscription.current_period_end * 1000).toISOString(),
    });
  } catch (error) {
    logger.error('Failed to preview upgrade', { error: error.message });
    res.status(500).json({ error: error.message || 'Failed to preview upgrade' });
  }
}

// Upgrade plan with proper proration and India compliance handling
export async function upgradePlan(req, res) {
  try {
    const userId = req.user.id;
    const { newPlanId, billingCycle } = req.body;

    if (!newPlanId || !billingCycle) {
      return res.status(400).json({ error: 'New plan ID and billing cycle are required' });
    }

    // 1. Get current subscription from DB
    const currentSubscription = await StripeSubscription.getActiveByUserId(userId);

    // Debug: Check all subscriptions if no active found
    if (!currentSubscription) {
      const allSubscriptions = await StripeSubscription.getByUserId(userId);
      logger.error('No active subscription found for upgrade', {
        userId,
        allSubscriptionsCount: allSubscriptions.length,
        allSubscriptions: allSubscriptions.map(s => ({
          id: s.id,
          stripe_subscription_id: s.stripe_subscription_id,
          status: s.status,
          plan_id: s.plan_id
        }))
      });
      return res.status(404).json({
        error: 'No active subscription found',
        debug: {
          foundSubscriptions: allSubscriptions.length,
          subscriptionStatuses: allSubscriptions.map(s => s.status)
        }
      });
    }

    // 2. Get new plan details from DB
    const newPlan = await Plan.getById(newPlanId);
    if (!newPlan) {
      return res.status(404).json({ error: 'Plan not found' });
    }

    // Get current plan to check if this is a downgrade
    const currentPlan = await Plan.getById(currentSubscription.plan_id);
    if (!currentPlan) {
      return res.status(404).json({ error: 'Current plan not found' });
    }

    // Calculate new amount
    const newAmount = billingCycle === 'monthly'
      ? parseFloat(newPlan.price_monthly)
      : parseFloat(newPlan.price_yearly);

    const currentAmount = currentSubscription.billing_cycle === 'monthly'
      ? parseFloat(currentPlan.price_monthly)
      : parseFloat(currentPlan.price_yearly);

    if (newAmount <= 0) {
      return res.status(400).json({ error: 'Plan not configured for this billing cycle' });
    }

    // Prevent downgrades to avoid credit balance issues
    if (newAmount < currentAmount) {
      return res.status(400).json({
        error: 'Downgrades are not supported. Please contact support to change to a lower plan.',
        currentPlan: currentPlan.name,
        requestedPlan: newPlan.name
      });
    }

    const stripe = stripeConfig.getStripe();

    // 3. Retrieve the full subscription object from Stripe
    // We need this to get the specific 'subscription_item' ID (si_...)
    const stripeSubscription = await stripe.subscriptions.retrieve(
      currentSubscription.stripe_subscription_id
    );

    // 4. CRITICAL: Clean up ANY pending invoice items before calculating proration.
    // This fixes the "accumulated charges" issue and the India "missing description" error
    // because pending items from failed attempts often lack descriptions.
    const pendingInvoiceItems = await stripe.invoiceItems.list({
      customer: stripeSubscription.customer,
      pending: true,
    });

    for (const item of pendingInvoiceItems.data) {
      await stripe.invoiceItems.del(item.id);
    }

    if (pendingInvoiceItems.data.length > 0) {
      logger.info(`Cleaned up ${pendingInvoiceItems.data.length} pending invoice items before upgrade`);
    }

    // 5. Identify the subscription item to update
    // Since you are using a single-plan model, it's usually the first item.
    const subscriptionItemId = stripeSubscription.items.data[0].id;

    if (!subscriptionItemId) {
      throw new Error('Could not find subscription item ID to update');
    }

    // 6. Create a product first (required for price_data in subscription updates)
    const product = await stripe.products.create({
      name: `${newPlan.name} Plan`,
      description: `${newPlan.description || newPlan.name} - ${billingCycle} subscription`,
    });

    // 7. Perform the Update
    // We update the EXISTING item (si_...) with the NEW price_data.
    // 'always_invoice' forces Stripe to calculate proration immediately and attempt payment.
    const updatedSubscription = await stripe.subscriptions.update(
      currentSubscription.stripe_subscription_id,
      {
        items: [{
          id: subscriptionItemId, // updating this specific item ensures proper credit for old plan
          price_data: {
            currency: 'usd',
            product: product.id, // Use the product ID we just created
            unit_amount: Math.round(newAmount * 100), // Stripe expects cents
            recurring: {
              interval: billingCycle === 'monthly' ? 'month' : 'year',
              interval_count: 1,
            },
          },
        }],
        proration_behavior: 'always_invoice', // Immediately generate invoice for the difference
        payment_behavior: 'pending_if_incomplete', // Don't crash if payment needs 3DS, just return pending
      }
    );

    // Update metadata separately (metadata not supported with pending_if_incomplete)
    await stripe.subscriptions.update(
      currentSubscription.stripe_subscription_id,
      {
        metadata: {
          userId: userId.toString(),
          planId: newPlanId.toString(),
          billingCycle,
          type: 'upgrade'
        },
      }
    );

    // 8. Retrieve the invoice generated by the update to show details
    let latestInvoice = await stripe.invoices.retrieve(updatedSubscription.latest_invoice, {
      expand: ['payment_intent', 'lines.data']
    });

    // 9. If invoice is in draft/open status, finalize and pay it
    if (latestInvoice.status === 'draft') {
      latestInvoice = await stripe.invoices.finalizeInvoice(latestInvoice.id);
      logger.info('Finalized invoice', { invoiceId: latestInvoice.id });
    }

    if (latestInvoice.status === 'open') {
      try {
        latestInvoice = await stripe.invoices.pay(latestInvoice.id);
        logger.info('Paid invoice immediately', {
          invoiceId: latestInvoice.id,
          amount: latestInvoice.amount_paid / 100
        });
      } catch (payError) {
        logger.error('Failed to pay invoice automatically', {
          invoiceId: latestInvoice.id,
          error: payError.message
        });
        // Don't throw - let user handle payment manually
      }
    }

    // 10. DB Updates will be handled by your webhook (invoice.paid / subscription.updated)
    // But we can log it here for debugging
    logger.info('Stripe: Plan upgrade initiated', {
      userId,
      oldSubscriptionId: currentSubscription.stripe_subscription_id,
      subscriptionItemId,
      newAmount: newAmount,
      invoiceTotal: latestInvoice.total / 100,
      invoiceAmountDue: latestInvoice.amount_due / 100,
      invoiceLineItems: latestInvoice.lines.data.map(line => ({
        description: line.description,
        amount: line.amount / 100,
        proration: line.proration,
        period: line.period ? {
          start: new Date(line.period.start * 1000).toISOString(),
          end: new Date(line.period.end * 1000).toISOString()
        } : null
      })),
      status: latestInvoice.status
    });

    res.json({
      message: 'Plan upgrade initiated successfully.',
      subscription: updatedSubscription,
      invoice: {
        id: latestInvoice.id,
        amount_due: latestInvoice.amount_due / 100,
        amount_paid: latestInvoice.amount_paid / 100,
        status: latestInvoice.status,
        url: latestInvoice.hosted_invoice_url,
        // If 3DS is required, the frontend needs the client_secret
        client_secret: latestInvoice.payment_intent?.client_secret
      },
      paymentStatus: latestInvoice.status === 'paid' ? 'success' : 'pending'
    });

  } catch (error) {
    logger.error('Failed to upgrade plan', { error: error.message, stack: error.stack });

    // Handle specific Stripe errors nicely
    if (error.type === 'StripeCardError') {
      return res.status(402).json({ error: 'Your card was declined. Please update your payment method.' });
    }

    res.status(500).json({ error: error.message || 'Failed to upgrade plan' });
  }
}

// Generate PDF invoice
export async function generatePdfInvoice(req, res) {
  try {
    const userId = req.user.id;
    const { invoiceId } = req.params;

    // Get invoice
    const invoice = await Invoice.getByStripeId(invoiceId);
    if (!invoice) {
      return res.status(404).json({ error: 'Invoice not found' });
    }

    // Check ownership if not admin
    if (req.user.role !== 'admin' && invoice.user_id !== userId) {
      return res.status(403).json({ error: 'Unauthorized' });
    }

    // Get user details
    const user = await User.getById(invoice.user_id);

    // Get Stripe invoice for full details
    const stripe = stripeConfig.getStripe();
    const stripeInvoice = await stripe.invoices.retrieve(invoiceId);

    // Get plan details if available
    const subscription = await StripeSubscription.getByStripeId(invoice.stripe_subscription_id);
    let plan = null;
    if (subscription && subscription.plan_id) {
      plan = await Plan.getById(subscription.plan_id);
    }

    // Generate PDF
    const filepath = await PdfService.generateInvoiceFromStripe(stripeInvoice, user, plan);

    // Send file
    res.download(filepath, `invoice-${stripeInvoice.number || invoiceId}.pdf`, (err) => {
      if (err) {
        logger.error('Failed to send PDF', { error: err.message });
        if (!res.headersSent) {
          res.status(500).json({ error: 'Failed to download invoice' });
        }
      }
    });
  } catch (error) {
    logger.error('Failed to generate PDF invoice', { error: error.message });
    res.status(500).json({ error: 'Failed to generate invoice PDF' });
  }
}

// ADMIN: Generate PDF for any invoice
export async function adminGeneratePdfInvoice(req, res) {
  try {
    const { invoiceId } = req.params;

    // Get invoice
    const invoice = await Invoice.getByStripeId(invoiceId);
    if (!invoice) {
      return res.status(404).json({ error: 'Invoice not found' });
    }

    // Get user details
    const user = await User.getById(invoice.user_id);

    // Get Stripe invoice for full details
    const stripe = stripeConfig.getStripe();
    const stripeInvoice = await stripe.invoices.retrieve(invoiceId);

    // Get plan details if available
    const subscription = await StripeSubscription.getByStripeId(invoice.stripe_subscription_id);
    let plan = null;
    if (subscription && subscription.plan_id) {
      plan = await Plan.getById(subscription.plan_id);
    }

    // Generate PDF
    const filepath = await PdfService.generateInvoiceFromStripe(stripeInvoice, user, plan);

    // Send file
    res.download(filepath, `invoice-${stripeInvoice.number || invoiceId}.pdf`, (err) => {
      if (err) {
        logger.error('Failed to send PDF', { error: err.message });
        if (!res.headersSent) {
          res.status(500).json({ error: 'Failed to download invoice' });
        }
      }
    });
  } catch (error) {
    logger.error('Failed to generate PDF invoice', { error: error.message });
    res.status(500).json({ error: 'Failed to generate invoice PDF' });
  }
}

// Clean up duplicate subscriptions
export async function cleanupDuplicateSubscriptions(req, res) {
  try {
    const db = (await import('../models/database.js')).default;

    // Find users with multiple active subscriptions
    const duplicatesQuery = `
      SELECT user_id, COUNT(*) as sub_count
      FROM stripe_subscriptions
      WHERE status IN ('active', 'trialing')
      GROUP BY user_id
      HAVING COUNT(*) > 1
    `;

    const duplicates = await db.query(duplicatesQuery);

    if (duplicates.rows.length === 0) {
      return res.json({
        message: 'No duplicate subscriptions found',
        cleanedCount: 0,
      });
    }

    let totalCleaned = 0;
    const cleanupDetails = [];

    // For each user with duplicates, keep only the most recent subscription
    for (const dup of duplicates.rows) {
      const userId = dup.user_id;

      // Get all active subscriptions for this user, ordered by creation date (newest first)
      const subsQuery = `
        SELECT id, stripe_subscription_id, plan_id, created_at
        FROM stripe_subscriptions
        WHERE user_id = $1 AND status IN ('active', 'trialing')
        ORDER BY created_at DESC
      `;

      const subs = await db.query(subsQuery, [userId]);

      // Keep the first (newest) subscription, cancel the rest
      const [keepSub, ...cancelSubs] = subs.rows;

      for (const oldSub of cancelSubs) {
        await db.query(
          `UPDATE stripe_subscriptions
           SET status = 'canceled', canceled_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP
           WHERE id = $1`,
          [oldSub.id]
        );

        totalCleaned++;
        cleanupDetails.push({
          userId,
          canceledSubscriptionId: oldSub.stripe_subscription_id,
          keptSubscriptionId: keepSub.stripe_subscription_id,
        });

        logger.info('Cleaned up duplicate subscription', {
          userId,
          canceledId: oldSub.stripe_subscription_id,
          keptId: keepSub.stripe_subscription_id,
        });
      }
    }

    res.json({
      message: `Successfully cleaned up ${totalCleaned} duplicate subscription(s)`,
      cleanedCount: totalCleaned,
      details: cleanupDetails,
    });
  } catch (error) {
    logger.error('Failed to cleanup duplicate subscriptions', { error: error.message });
    res.status(500).json({ error: 'Failed to cleanup duplicate subscriptions' });
  }
}

// Get Stripe invoice details (admin only - for debugging)
export async function getStripeInvoiceDetails(req, res) {
  try {
    const { invoiceId } = req.params;
    const stripe = stripeConfig.getStripe();

    // Retrieve invoice with expanded line items
    const invoice = await stripe.invoices.retrieve(invoiceId, {
      expand: ['lines.data.price', 'lines.data.proration_details']
    });

    res.json({
      id: invoice.id,
      total: invoice.total / 100,
      amountPaid: invoice.amount_paid / 100,
      amountDue: invoice.amount_due / 100,
      status: invoice.status,
      billingReason: invoice.billing_reason,
      lineItems: invoice.lines.data.map(item => ({
        id: item.id,
        description: item.description,
        amount: item.amount / 100,
        quantity: item.quantity,
        proration: item.proration,
        period: item.period ? {
          start: new Date(item.period.start * 1000).toISOString(),
          end: new Date(item.period.end * 1000).toISOString()
        } : null
      }))
    });
  } catch (error) {
    logger.error('Failed to get Stripe invoice details', { error: error.message });
    res.status(500).json({ error: error.message || 'Failed to get invoice details' });
  }
}

// Sync subscription from Stripe (admin only - for fixing missing plan_id)
export async function syncSubscriptionFromStripe(req, res) {
  try {
    const { subscriptionId } = req.params;

    const stripe = stripeConfig.getStripe();

    // Get subscription from Stripe
    const stripeSubscription = await stripe.subscriptions.retrieve(subscriptionId);

    if (!stripeSubscription) {
      return res.status(404).json({ error: 'Subscription not found in Stripe' });
    }

    // Get plan ID from metadata
    const planId = stripeSubscription.metadata?.planId ? parseInt(stripeSubscription.metadata.planId) : null;

    if (!planId) {
      return res.status(400).json({ error: 'No planId found in subscription metadata' });
    }

    // Get local subscription
    const localSub = await StripeSubscription.getByStripeId(subscriptionId);

    if (!localSub) {
      return res.status(404).json({ error: 'Subscription not found in database' });
    }

    // Update local subscription with plan ID
    await StripeSubscription.update(subscriptionId, {
      planId: planId,
    });

    // Update user's plan
    await User.update(localSub.user_id, {
      plan_id: planId,
    });

    logger.info('Synced subscription from Stripe', {
      subscriptionId,
      planId,
      userId: localSub.user_id,
    });

    res.json({
      message: 'Subscription synced successfully',
      subscriptionId,
      planId,
    });
  } catch (error) {
    logger.error('Failed to sync subscription', { error: error.message });
    res.status(500).json({ error: 'Failed to sync subscription' });
  }
}
