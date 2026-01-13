import stripeConfig from '../config/stripe.js';
import StripeSubscription from '../models/StripeSubscription.js';
import Invoice from '../models/Invoice.js';
import User from '../models/User.js';
import StripeCustomer from '../models/StripeCustomer.js';
import CouponCode from '../models/CouponCode.js';
import logger from '../utils/logger.js';
import { sendSubscriptionEmail } from '../services/EmailService.js';
import PushoverService from '../services/PushoverService.js';

// Stripe webhook handler
export async function handleStripeWebhook(req, res) {
  const sig = req.headers['stripe-signature'];
  const webhookSecret = stripeConfig.getWebhookSecret();

  logger.info('Stripe Webhook: Received webhook request', {
    hasSignature: !!sig,
    hasSecret: !!webhookSecret,
    bodyType: typeof req.body,
    isBuffer: Buffer.isBuffer(req.body),
    contentType: req.headers['content-type'],
  });

  if (!webhookSecret) {
    logger.error('Stripe Webhook: No webhook secret configured');
    return res.status(400).send('Webhook secret not configured');
  }

  if (!sig) {
    logger.error('Stripe Webhook: No signature header found');
    return res.status(400).send('No signature header found');
  }

  let event;

  try {
    const stripe = stripeConfig.getStripe();
    event = stripe.webhooks.constructEvent(req.body, sig, webhookSecret);
  } catch (err) {
    logger.error('Stripe Webhook: Signature verification failed', {
      error: err.message,
      bodyPreview: req.body ? req.body.toString().substring(0, 100) : 'null',
    });
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  // Handle the event
  try {
    switch (event.type) {
      case 'checkout.session.completed':
        await handleCheckoutSessionCompleted(event.data.object);
        break;

      case 'customer.subscription.created':
      case 'customer.subscription.updated':
        await handleSubscriptionUpdated(event.data.object);
        break;

      case 'customer.subscription.deleted':
        await handleSubscriptionDeleted(event.data.object);
        break;

      case 'invoice.paid':
        await handleInvoicePaid(event.data.object);
        break;

      case 'invoice.payment_failed':
        await handleInvoicePaymentFailed(event.data.object);
        break;

      case 'customer.subscription.trial_will_end':
        await handleTrialWillEnd(event.data.object);
        break;

      default:
        logger.info(`Stripe Webhook: Unhandled event type ${event.type}`);
    }

    res.json({ received: true });
  } catch (error) {
    logger.error('Stripe Webhook: Error processing event', {
      type: event.type,
      error: error.message,
    });
    res.status(500).json({ error: 'Webhook processing failed' });
  }
}

// Handle successful checkout
async function handleCheckoutSessionCompleted(session) {
  const userId = parseInt(session.metadata.userId);
  const planId = parseInt(session.metadata.planId);
  const billingCycle = session.metadata.billingCycle;

  logger.info('Stripe Webhook: Checkout session completed', {
    userId,
    sessionId: session.id,
  });

  // The subscription will be created/updated by subscription.created or subscription.updated event
  // We just log the checkout completion here
}

// Handle subscription created or updated
async function handleSubscriptionUpdated(subscription) {
  const customerId = subscription.customer;
  const subscriptionId = subscription.id;

  // Get user from Stripe customer
  const stripeCustomer = await StripeCustomer.getByStripeId(customerId);
  if (!stripeCustomer) {
    logger.error('Stripe Webhook: Customer not found', { customerId });
    return;
  }

  const userId = stripeCustomer.user_id;

  // Extract subscription details
  const priceId = subscription.items.data[0]?.price.id;
  const status = subscription.status;
  const currentPeriodStart = new Date(subscription.current_period_start * 1000);
  const currentPeriodEnd = new Date(subscription.current_period_end * 1000);
  const cancelAtPeriodEnd = subscription.cancel_at_period_end;

  // Determine billing cycle from price
  const interval = subscription.items.data[0]?.price.recurring?.interval;
  const billingCycle = interval === 'year' ? 'yearly' : 'monthly';

  // Get planId from subscription metadata (set during checkout)
  const planId = subscription.metadata?.planId ? parseInt(subscription.metadata.planId) : null;

  const db = (await import('../models/database.js')).default;

  // If no planId in metadata, try to find by price ID (fallback for old subscriptions)
  let finalPlanId = planId;
  if (!finalPlanId) {
    const planQuery = billingCycle === 'monthly'
      ? 'SELECT id FROM plans WHERE stripe_price_id_monthly = $1'
      : 'SELECT id FROM plans WHERE stripe_price_id_yearly = $1';
    const planResult = await db.query(planQuery, [priceId]);
    finalPlanId = planResult.rows[0]?.id;
  }

  // Check if subscription exists
  const existingSub = await StripeSubscription.getByStripeId(subscriptionId);

  if (existingSub) {
    // Check if plan changed (upgrade/downgrade)
    const oldPlanId = existingSub.plan_id;
    const planChanged = finalPlanId && oldPlanId && finalPlanId !== oldPlanId;

    // Update existing subscription
    await StripeSubscription.update(subscriptionId, {
      status,
      currentPeriodStart,
      currentPeriodEnd,
      cancelAtPeriodEnd,
      stripePriceId: priceId,
      billingCycle,
      ...(finalPlanId && { planId: finalPlanId }),
    });

    // Send notification if plan changed
    if (planChanged) {
      const Plan = (await import('../models/Plan.js')).default;
      const oldPlan = await Plan.getById(oldPlanId);
      const newPlan = await Plan.getById(finalPlanId);
      const User = (await import('../models/User.js')).default;
      const user = await User.findById(userId);

      const isUpgrade = parseFloat(newPlan.price_monthly) > parseFloat(oldPlan.price_monthly);
      const action = isUpgrade ? 'upgraded' : 'downgraded';

      // Send email to user
      await sendSubscriptionEmail(user.email, action, {
        planName: newPlan.name,
        billingCycle: billingCycle
      });

      // Send Pushover notification to admin
      await PushoverService.sendNotification(
        `[ADMIN] Plan ${isUpgrade ? 'Upgrade' : 'Change'} - ${newPlan.name}`,
        `${user.email} ${action} from ${oldPlan.name} to ${newPlan.name} (${billingCycle})`
      );

      logger.info(`Stripe Webhook: Plan ${action}`, {
        userId,
        oldPlan: oldPlan.name,
        newPlan: newPlan.name,
        subscriptionId,
      });
    } else {
      logger.info('Stripe Webhook: Subscription updated', {
        userId,
        subscriptionId,
        status,
        planId: finalPlanId,
      });
    }
  } else {
    // Before creating new subscription, cancel any other active subscriptions for this user
    // This handles cases where Stripe creates a new subscription ID during plan changes
    const activeSubscriptions = await db.query(
      `SELECT stripe_subscription_id FROM stripe_subscriptions
       WHERE user_id = $1 AND status IN ('active', 'trialing') AND stripe_subscription_id != $2`,
      [userId, subscriptionId]
    );

    for (const oldSub of activeSubscriptions.rows) {
      await StripeSubscription.update(oldSub.stripe_subscription_id, {
        status: 'canceled',
        canceledAt: new Date(),
      });
      logger.info('Stripe Webhook: Auto-cancelled old subscription', {
        userId,
        oldSubscriptionId: oldSub.stripe_subscription_id,
        newSubscriptionId: subscriptionId,
      });
    }

    // Create new subscription
    await StripeSubscription.create({
      userId,
      stripeCustomerId: customerId,
      stripeSubscriptionId: subscriptionId,
      stripePriceId: priceId,
      planId: finalPlanId,
      status,
      billingCycle,
      currentPeriodStart,
      currentPeriodEnd,
    });

    logger.info('Stripe Webhook: Subscription created', {
      userId,
      subscriptionId,
      status,
      planId: finalPlanId,
    });
  }

  // Update user's subscription status
  if (finalPlanId) {
    await User.update(userId, {
      plan_id: finalPlanId,
      subscription_type: billingCycle,
      subscription_status: status === 'active' || status === 'trialing' ? 'active' : 'cancelled',
      subscription_started_at: currentPeriodStart.toISOString(),
      subscription_expires_at: currentPeriodEnd.toISOString(),
      stripe_customer_id: customerId,
      stripe_subscription_id: subscriptionId,
    });
  }

  // Send email notifications
  const user = await User.getById(userId);
  if (status === 'active' && !existingSub) {
    // Get plan details
    const plan = finalPlanId ? await db.query('SELECT * FROM plans WHERE id = $1', [finalPlanId]) : null;
    const planName = plan?.rows[0]?.name || 'Unknown';
    const amount = billingCycle === 'monthly' ? plan?.rows[0]?.price_monthly : plan?.rows[0]?.price_yearly;

    // Send email to customer
    await sendSubscriptionEmail(user.email, 'activated', {
      planName,
      billingCycle,
    });

    // Send admin notification email
    const settings = await db.query('SELECT value FROM settings WHERE key = $1', ['admin_notification_email']);
    const adminEmail = settings.rows[0]?.value;

    if (adminEmail) {
      await sendSubscriptionEmail(adminEmail, 'admin_new_subscription', {
        userId,
        userEmail: user.email,
        planName,
        billingCycle,
        amount: amount || 0,
        currency: 'USD',
      });
    }

    // Send Pushover notification to admin
    const PushoverService = (await import('../services/PushoverService.js')).default;
    await PushoverService.sendNotification(
      `New Subscription`,
      `${user.email} subscribed to ${planName} (${billingCycle}) - $${amount || 0}`
    );
  }

  // Record coupon redemption if applicable
  if (subscription.discount && subscription.discount.coupon) {
    const stripeCouponId = subscription.discount.coupon.id;
    const coupon = await db.query('SELECT * FROM coupon_codes WHERE stripe_coupon_id = $1', [stripeCouponId]);
    if (coupon.rows.length > 0) {
      await CouponCode.recordRedemption(coupon.rows[0].id, userId, subscriptionId);
    }
  }
}

// Handle subscription deleted
async function handleSubscriptionDeleted(subscription) {
  const subscriptionId = subscription.id;

  const existingSub = await StripeSubscription.getByStripeId(subscriptionId);
  if (!existingSub) {
    logger.warn('Stripe Webhook: Subscription not found for deletion', {
      subscriptionId,
    });
    return;
  }

  // Update subscription status
  await StripeSubscription.update(subscriptionId, {
    status: 'canceled',
    cancelAtPeriodEnd: false,
    canceledAt: new Date(),
  });

  // Update user status
  await User.update(existingSub.user_id, {
    subscription_status: 'cancelled',
  });

  logger.info('Stripe Webhook: Subscription deleted', {
    userId: existingSub.user_id,
    subscriptionId,
  });

  // Send cancellation email
  const user = await User.getById(existingSub.user_id);
  await sendSubscriptionEmail(user.email, 'cancelled', {});
}

// Handle successful invoice payment
async function handleInvoicePaid(invoice) {
  const customerId = invoice.customer;
  const invoiceId = invoice.id;
  const subscriptionId = invoice.subscription;

  // Get user from customer
  const stripeCustomer = await StripeCustomer.getByStripeId(customerId);
  if (!stripeCustomer) {
    logger.error('Stripe Webhook: Customer not found for invoice', {
      customerId,
    });
    return;
  }

  const userId = stripeCustomer.user_id;

  // Check if invoice exists
  const existingInvoice = await Invoice.getByStripeId(invoiceId);

  if (existingInvoice) {
    // Update existing invoice
    await Invoice.update(invoiceId, {
      status: invoice.status,
      paid: true,
      paidAt: new Date(invoice.status_transitions.paid_at * 1000),
    });
  } else {
    // Create new invoice
    await Invoice.create({
      userId,
      stripeInvoiceId: invoiceId,
      stripeSubscriptionId: subscriptionId,
      amountTotal: invoice.amount_paid / 100, // Convert from cents
      currency: invoice.currency,
      status: invoice.status,
      invoicePdf: invoice.invoice_pdf,
      hostedInvoiceUrl: invoice.hosted_invoice_url,
      billingReason: invoice.billing_reason,
      paid: true,
      paidAt: new Date(invoice.status_transitions.paid_at * 1000),
      dueDate: invoice.due_date ? new Date(invoice.due_date * 1000) : null,
    });
  }

  logger.info('Stripe Webhook: Invoice paid', {
    userId,
    invoiceId,
    amount: invoice.amount_paid / 100,
  });

  // Send payment confirmation email
  const user = await User.getById(userId);
  await sendSubscriptionEmail(user.email, 'payment_success', {
    amount: invoice.amount_paid / 100,
    currency: invoice.currency.toUpperCase(),
    invoiceUrl: invoice.hosted_invoice_url,
  });
}

// Handle failed invoice payment
async function handleInvoicePaymentFailed(invoice) {
  const customerId = invoice.customer;
  const invoiceId = invoice.id;

  const stripeCustomer = await StripeCustomer.getByStripeId(customerId);
  if (!stripeCustomer) {
    logger.error('Stripe Webhook: Customer not found for failed payment', {
      customerId,
    });
    return;
  }

  const userId = stripeCustomer.user_id;

  logger.warn('Stripe Webhook: Invoice payment failed', {
    userId,
    invoiceId,
  });

  // Update or create invoice with failed status
  const existingInvoice = await Invoice.getByStripeId(invoiceId);
  if (existingInvoice) {
    await Invoice.update(invoiceId, {
      status: 'uncollectible',
      paid: false,
    });
  } else {
    await Invoice.create({
      userId,
      stripeInvoiceId: invoiceId,
      stripeSubscriptionId: invoice.subscription,
      amountTotal: invoice.amount_due / 100,
      currency: invoice.currency,
      status: 'uncollectible',
      hostedInvoiceUrl: invoice.hosted_invoice_url,
      billingReason: invoice.billing_reason,
      paid: false,
      dueDate: invoice.due_date ? new Date(invoice.due_date * 1000) : null,
    });
  }

  // Send payment failed email
  const user = await User.getById(userId);
  await sendSubscriptionEmail(user.email, 'payment_failed', {
    amount: invoice.amount_due / 100,
    currency: invoice.currency.toUpperCase(),
    invoiceUrl: invoice.hosted_invoice_url,
  });

  // Send admin notification
  await sendSubscriptionEmail(process.env.ADMIN_EMAIL, 'admin_payment_failed', {
    userEmail: user.email,
    userId,
    amount: invoice.amount_due / 100,
  });
}

// Handle trial ending soon
async function handleTrialWillEnd(subscription) {
  const customerId = subscription.customer;
  const trialEnd = new Date(subscription.trial_end * 1000);

  const stripeCustomer = await StripeCustomer.getByStripeId(customerId);
  if (!stripeCustomer) {
    return;
  }

  const user = await User.getById(stripeCustomer.user_id);

  logger.info('Stripe Webhook: Trial ending soon', {
    userId: user.id,
    trialEnd,
  });

  await sendSubscriptionEmail(user.email, 'trial_ending', {
    trialEndDate: trialEnd.toLocaleDateString(),
  });
}
