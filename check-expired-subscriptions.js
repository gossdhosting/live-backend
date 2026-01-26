/**
 * Check and handle expired subscriptions
 * This script should be run periodically (e.g., every hour) via cron
 *
 * Usage: node check-expired-subscriptions.js
 */

import db from './src/models/database.js';
import User from './src/models/User.js';
import Plan from './src/models/Plan.js';
import StripeSubscription from './src/models/StripeSubscription.js';
import { sendSubscriptionEmail } from './src/services/EmailService.js';
import logger from './src/utils/logger.js';
import OneSignalService from './src/services/OneSignalService.js';

async function checkExpiredSubscriptions() {
  try {
    console.log('[EXPIRY-CHECK] 🕐 Starting expiry check...');
    logger.info('Starting subscription expiry check');

    // Find all active subscriptions that have expired
    const result = await db.query(`
      SELECT
        ss.stripe_subscription_id,
        ss.user_id,
        ss.plan_id,
        ss.status,
        ss.current_period_end,
        u.email,
        u.name,
        u.plan_id as user_plan_id
      FROM stripe_subscriptions ss
      JOIN users u ON ss.user_id = u.id
      WHERE ss.status IN ('active', 'trialing')
      AND ss.current_period_end < NOW()
      ORDER BY ss.current_period_end ASC
    `);

    const expiredSubs = result.rows;

    if (expiredSubs.length === 0) {
      console.log('[EXPIRY-CHECK] ✅ No expired subscriptions found');
      logger.info('No expired subscriptions found');
      return;
    }

    console.log(`[EXPIRY-CHECK] ⚠️ Found ${expiredSubs.length} expired subscription(s)`);
    logger.info('Found expired subscriptions', { count: expiredSubs.length });

    // Get Free plan
    const freePlan = await Plan.getByName('Free');
    if (!freePlan) {
      throw new Error('Free plan not found in database');
    }

    let processedCount = 0;
    let errorCount = 0;

    for (const sub of expiredSubs) {
      try {
        console.log(`[EXPIRY-CHECK] Processing subscription ${sub.stripe_subscription_id}`);
        console.log(`[EXPIRY-CHECK] - User: ${sub.email} (ID: ${sub.user_id})`);
        console.log(`[EXPIRY-CHECK] - Expired: ${sub.current_period_end}`);

        // Mark subscription as expired
        await StripeSubscription.update(sub.stripe_subscription_id, {
          status: 'expired',
        });

        console.log(`[EXPIRY-CHECK] - Subscription marked as expired`);

        // Downgrade user to Free plan
        await User.update(sub.user_id, {
          plan_id: freePlan.id,
          subscription_status: 'expired',
        });

        console.log(`[EXPIRY-CHECK] - User downgraded to Free plan`);

        // Send email notification
        try {
          await sendSubscriptionEmail(sub.email, 'expired', {
            name: sub.name,
            planId: sub.plan_id,
            expiryDate: sub.current_period_end,
          });
          console.log(`[EXPIRY-CHECK] - Email notification sent`);
        } catch (emailError) {
          // Don't fail the whole process if email fails
          console.log(`[EXPIRY-CHECK] - Email notification failed: ${emailError.message}`);
          logger.error('Failed to send expiry email', {
            error: emailError.message,
            userId: sub.user_id,
            email: sub.email,
          });
        }

        // Send OneSignal push notification
        try {
          const plan = await Plan.findById(sub.plan_id);
          const playerId = await User.getOneSignalPlayerId(sub.user_id);
          if (playerId && plan) {
            await OneSignalService.notifySubscriptionExpired(playerId, plan.name);
            console.log(`[EXPIRY-CHECK] - Push notification sent`);
          }
        } catch (pushError) {
          console.log(`[EXPIRY-CHECK] - Push notification failed: ${pushError.message}`);
          logger.error('Failed to send expiry push notification', {
            error: pushError.message,
            userId: sub.user_id,
          });
        }

        logger.info('Subscription expired and user downgraded', {
          userId: sub.user_id,
          email: sub.email,
          subscriptionId: sub.stripe_subscription_id,
          oldPlanId: sub.plan_id,
          newPlanId: freePlan.id,
        });

        processedCount++;
      } catch (error) {
        errorCount++;
        console.error(`[EXPIRY-CHECK] ❌ Error processing subscription ${sub.stripe_subscription_id}:`, error.message);
        logger.error('Failed to process expired subscription', {
          error: error.message,
          subscriptionId: sub.stripe_subscription_id,
          userId: sub.user_id,
        });
      }
    }

    console.log(`[EXPIRY-CHECK] ✅ Expiry check complete`);
    console.log(`[EXPIRY-CHECK] - Processed: ${processedCount}`);
    console.log(`[EXPIRY-CHECK] - Errors: ${errorCount}`);

    logger.info('Subscription expiry check complete', {
      total: expiredSubs.length,
      processed: processedCount,
      errors: errorCount,
    });

  } catch (error) {
    console.error('[EXPIRY-CHECK] ❌ Fatal error:', error.message);
    logger.error('Fatal error in subscription expiry check', {
      error: error.message,
      stack: error.stack,
    });
    process.exit(1);
  }
}

// Run the check
checkExpiredSubscriptions()
  .then(() => {
    console.log('[EXPIRY-CHECK] 🎉 Script finished successfully');
    process.exit(0);
  })
  .catch((error) => {
    console.error('[EXPIRY-CHECK] 💥 Script failed:', error);
    process.exit(1);
  });
