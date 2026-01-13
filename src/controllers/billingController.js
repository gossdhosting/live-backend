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

    // Get Stripe price ID from plan
    const stripePriceId = billingCycle === 'monthly'
      ? plan.stripe_price_id_monthly
      : plan.stripe_price_id_yearly;

    if (!stripePriceId) {
      return res.status(400).json({
        error: 'This plan is not configured for Stripe payments. Please contact administrator.',
      });
    }

    const stripe = stripeConfig.getStripe();
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

    // Get or create Stripe customer
    let stripeCustomer = await StripeCustomer.getByUserId(userId);
    let customerId;

    if (stripeCustomer) {
      customerId = stripeCustomer.stripe_customer_id;
    } else {
      const customer = await stripe.customers.create({
        email: user.email,
        metadata: {
          userId: userId.toString(),
        },
      });
      customerId = customer.id;
      await StripeCustomer.create(userId, customerId, user.email);
    }

    // Create checkout session
    const sessionConfig = {
      customer: customerId,
      payment_method_types: ['card'],
      line_items: [
        {
          price: stripePriceId,
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
    const settings = await PaymentSettings.get();
    // Mask secret keys for security while showing they exist
    if (settings) {
      if (settings.stripe_secret_key) {
        // Show first 7 chars and mask the rest (e.g., sk_test_****...)
        settings.stripe_secret_key = settings.stripe_secret_key.substring(0, 7) + '••••••••••••••••••••••••••••';
      }
      if (settings.stripe_webhook_secret) {
        // Show first 7 chars and mask the rest
        settings.stripe_webhook_secret = settings.stripe_webhook_secret.substring(0, 7) + '••••••••••••••••••••••••••••';
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
      stripe_publishable_key,
      stripe_secret_key,
      stripe_webhook_secret,
      mode,
    } = req.body;

    // Don't update with masked values - treat them as unchanged
    if (stripe_secret_key && stripe_secret_key.includes('••••')) {
      stripe_secret_key = null; // null means don't update this field (COALESCE will keep existing)
    }
    if (stripe_webhook_secret && stripe_webhook_secret.includes('••••')) {
      stripe_webhook_secret = null;
    }

    const settings = await PaymentSettings.update({
      stripe_publishable_key,
      stripe_secret_key,
      stripe_webhook_secret,
      mode,
    });

    // Reinitialize Stripe with new settings
    await stripeConfig.reinitialize();

    // Mask secret keys before sending back
    if (settings.stripe_secret_key) {
      settings.stripe_secret_key = settings.stripe_secret_key.substring(0, 7) + '••••••••••••••••••••••••••••';
    }
    if (settings.stripe_webhook_secret) {
      settings.stripe_webhook_secret = settings.stripe_webhook_secret.substring(0, 7) + '••••••••••••••••••••••••••••';
    }

    logger.info('Stripe: Payment settings updated', { mode: settings.mode });

    res.json({ settings, message: 'Payment settings updated successfully' });
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

// Upgrade plan with prorated pricing
export async function upgradePlan(req, res) {
  try {
    const userId = req.user.id;
    const { newPlanId, billingCycle } = req.body;

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

    // Get new price ID
    const newPriceId = billingCycle === 'monthly'
      ? newPlan.stripe_price_id_monthly
      : newPlan.stripe_price_id_yearly;

    if (!newPriceId) {
      return res.status(400).json({ error: 'Plan not configured for this billing cycle' });
    }

    const stripe = stripeConfig.getStripe();

    // Get current subscription from Stripe
    const stripeSubscription = await stripe.subscriptions.retrieve(
      currentSubscription.stripe_subscription_id
    );

    // Update subscription with proration
    const updatedSubscription = await stripe.subscriptions.update(
      currentSubscription.stripe_subscription_id,
      {
        items: [
          {
            id: stripeSubscription.items.data[0].id,
            price: newPriceId,
          },
        ],
        proration_behavior: 'create_prorations',
      }
    );

    logger.info('Stripe: Plan upgraded', {
      userId,
      oldPlanId: currentSubscription.plan_id,
      newPlanId,
    });

    res.json({
      message: 'Plan upgraded successfully',
      subscription: updatedSubscription,
    });
  } catch (error) {
    logger.error('Failed to upgrade plan', { error: error.message });
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
