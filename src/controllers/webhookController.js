import stripeConfig from '../config/stripe.js';
import StripeSubscription from '../models/StripeSubscription.js';
import Invoice from '../models/Invoice.js';
import User from '../models/User.js';
import StripeCustomer from '../models/StripeCustomer.js';
import CouponCode from '../models/CouponCode.js';
import logger from '../utils/logger.js';
import { sendSubscriptionEmail } from '../services/emailService.js';

// Stripe webhook handler
export async function handleStripeWebhook(req, res) {
  const sig = req.headers['stripe-signature'];
  const webhookSecret = stripeConfig.getWebhookSecret();

  if (!webhookSecret) {
    logger.error('Stripe Webhook: No webhook secret configured');
    return res.status(400).send('Webhook secret not configured');
  }

  let event;

  try {
    const stripe = stripeConfig.getStripe();
    event = stripe.webhooks.constructEvent(req.body, sig, webhookSecret);
  } catch (err) {
    logger.error('Stripe Webhook: Signature verification failed', {
      error: err.message,
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

  // Find plan by stripe price ID
  const db = (await import('../config/database.js')).default;
  const planQuery = billingCycle === 'monthly'
    ? 'SELECT id FROM plans WHERE stripe_price_id_monthly = $1'
    : 'SELECT id FROM plans WHERE stripe_price_id_yearly = $1';
  const planResult = await db.query(planQuery, [priceId]);
  const planId = planResult.rows[0]?.id;

  // Check if subscription exists
  const existingSub = await StripeSubscription.getByStripeId(subscriptionId);

  if (existingSub) {
    // Update existing subscription
    await StripeSubscription.update(subscriptionId, {
      status,
      currentPeriodStart,
      currentPeriodEnd,
      cancelAtPeriodEnd,
      stripePriceId: priceId,
      billingCycle,
      ...(planId && { planId }),
    });

    logger.info('Stripe Webhook: Subscription updated', {
      userId,
      subscriptionId,
      status,
    });
  } else {
    // Create new subscription
    await StripeSubscription.create({
      userId,
      stripeCustomerId: customerId,
      stripeSubscriptionId: subscriptionId,
      stripePriceId: priceId,
      planId,
      status,
      billingCycle,
      currentPeriodStart,
      currentPeriodEnd,
    });

    logger.info('Stripe Webhook: Subscription created', {
      userId,
      subscriptionId,
      status,
    });
  }

  // Update user's subscription status
  if (planId) {
    await User.update(userId, {
      plan_id: planId,
      subscription_type: billingCycle,
      subscription_status: status === 'active' || status === 'trialing' ? 'active' : 'cancelled',
      subscription_started_at: currentPeriodStart.toISOString(),
      subscription_expires_at: currentPeriodEnd.toISOString(),
      stripe_customer_id: customerId,
      stripe_subscription_id: subscriptionId,
    });
  }

  // Send email notification
  const user = await User.getById(userId);
  if (status === 'active' && !existingSub) {
    await sendSubscriptionEmail(user.email, 'activated', {
      planName: planResult.rows[0]?.name || 'Unknown',
      billingCycle,
    });
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
