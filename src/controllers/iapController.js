import User from '../models/User.js';
import Plan from '../models/Plan.js';
import StripeSubscription from '../models/StripeSubscription.js';
import logger from '../utils/logger.js';
import { sendSubscriptionEmail } from '../services/EmailService.js';

// Platform commission rates
const PLATFORM_MARKUP = {
  android: 0.43, // 43% markup to cover 30% Google Play fee
  ios: 0.43,     // 43% markup to cover 30% App Store fee
};

// Google Play verification
async function verifyGooglePlayPurchase(purchaseToken, productId, packageName) {
  // Note: You need to set up Google Play Developer API
  // This requires service account credentials

  try {
    const { google } = await import('googleapis');

    // Load credentials from environment or service account file
    const auth = new google.auth.GoogleAuth({
      keyFile: process.env.GOOGLE_SERVICE_ACCOUNT_KEY_FILE,
      scopes: ['https://www.googleapis.com/auth/androidpublisher'],
    });

    const androidPublisher = google.androidpublisher({
      version: 'v3',
      auth: auth,
    });

    const response = await androidPublisher.purchases.subscriptions.get({
      packageName: packageName || process.env.ANDROID_PACKAGE_NAME || 'com.rexstream.app',
      subscriptionId: productId,
      token: purchaseToken,
    });

    return {
      valid: response.data.paymentState === 1, // 1 = Payment received
      expiryTime: parseInt(response.data.expiryTimeMillis),
      autoRenewing: response.data.autoRenewing,
      orderId: response.data.orderId,
    };
  } catch (error) {
    logger.error('Google Play verification failed', { error: error.message });
    return { valid: false, error: error.message };
  }
}

// Apple App Store verification
async function verifyAppleAppStorePurchase(receiptData, isProduction = true) {
  try {
    const https = await import('https');

    // Use production or sandbox URL
    const verifyUrl = isProduction
      ? 'https://buy.itunes.apple.com/verifyReceipt'
      : 'https://sandbox.itunes.apple.com/verifyReceipt';

    const requestData = JSON.stringify({
      'receipt-data': receiptData,
      password: process.env.APPLE_SHARED_SECRET, // Your app-specific shared secret
      'exclude-old-transactions': true,
    });

    const response = await new Promise((resolve, reject) => {
      const req = https.request(
        verifyUrl,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Content-Length': requestData.length,
          },
        },
        (res) => {
          let data = '';
          res.on('data', (chunk) => (data += chunk));
          res.on('end', () => resolve(JSON.parse(data)));
        }
      );

      req.on('error', reject);
      req.write(requestData);
      req.end();
    });

    // Status codes: 0 = valid, 21007 = sandbox receipt sent to production
    if (response.status === 21007) {
      // Retry with sandbox
      return await verifyAppleAppStorePurchase(receiptData, false);
    }

    if (response.status === 0) {
      const latestReceipt = response.latest_receipt_info?.[0] || response.receipt?.in_app?.[0];

      return {
        valid: true,
        expiryTime: parseInt(latestReceipt?.expires_date_ms || 0),
        transactionId: latestReceipt?.transaction_id,
        originalTransactionId: latestReceipt?.original_transaction_id,
      };
    }

    logger.error('Apple verification failed', { status: response.status });
    return { valid: false, error: `Invalid receipt status: ${response.status}` };
  } catch (error) {
    logger.error('Apple App Store verification failed', { error: error.message });
    return { valid: false, error: error.message };
  }
}

// Verify IAP purchase
export async function verifyIAPPurchase(req, res) {
  try {
    const userId = req.user.id;
    const { platform, productId, purchaseId, verificationData } = req.body;

    if (!platform || !productId || !verificationData) {
      return res.status(400).json({ error: 'Missing required fields' });
    }

    logger.info('Verifying IAP purchase', { userId, platform, productId });

    let verificationResult;

    if (platform === 'android') {
      verificationResult = await verifyGooglePlayPurchase(
        verificationData,
        productId,
        process.env.ANDROID_PACKAGE_NAME
      );
    } else if (platform === 'ios') {
      verificationResult = await verifyAppleAppStorePurchase(verificationData);
    } else {
      return res.status(400).json({ error: 'Invalid platform' });
    }

    if (!verificationResult.valid) {
      logger.warn('IAP verification failed', { userId, platform, error: verificationResult.error });
      return res.json({ verified: false, error: verificationResult.error });
    }

    logger.info('IAP purchase verified', { userId, platform, productId });

    res.json({
      verified: true,
      expiryTime: verificationResult.expiryTime,
      transactionId: verificationResult.transactionId || verificationResult.orderId,
    });
  } catch (error) {
    logger.error('IAP verification error', { error: error.message });
    res.status(500).json({ error: 'Verification failed' });
  }
}

// Map product ID plan names to database plan IDs
const PLAN_NAME_TO_ID = {
  'basic': 2,
  'pro': 3,
  'enterprise': 4,
  'enterprice': 4, // Handle typo in Google Play Console
};

// Parse product ID to extract plan info
// Supports formats:
//   - rexstream-{planName}-{cycle} (e.g., rexstream-basic-monthly)
//   - com.rexstream.plan_{planId}_{cycle} (legacy format)
function parseProductId(productId) {
  // Try new format: rexstream-{planName}-{cycle}
  if (productId.startsWith('rexstream-')) {
    const parts = productId.split('-');
    if (parts.length >= 3) {
      const planName = parts[1].toLowerCase();
      const cycle = parts[2];
      const planId = PLAN_NAME_TO_ID[planName];

      if (planId) {
        return { planId, billingCycle: cycle };
      }
    }
  }

  // Try legacy format: com.rexstream.plan_{planId}_{cycle}
  const underscoreParts = productId.split('_');
  if (underscoreParts.length >= 3) {
    const planId = parseInt(underscoreParts[1]);
    const billingCycle = underscoreParts[2];

    if (!isNaN(planId)) {
      return { planId, billingCycle };
    }
  }

  return null;
}

// Activate IAP subscription
export async function activateIAPSubscription(req, res) {
  try {
    const userId = req.user.id;
    const { platform, productId, purchaseId, verificationData } = req.body;

    if (!platform || !productId || !verificationData) {
      return res.status(400).json({ error: 'Missing required fields' });
    }

    // Parse plan info from product ID
    const planInfo = parseProductId(productId);
    if (!planInfo) {
      logger.error('Invalid product ID format', { productId });
      return res.status(400).json({ error: 'Invalid product ID format' });
    }

    const { planId, billingCycle } = planInfo;

    // Get plan details
    const plan = await Plan.getById(planId);
    if (!plan) {
      logger.error('Plan not found for IAP', { productId, planId });
      return res.status(404).json({ error: 'Plan not found' });
    }

    // Verify purchase again for security
    let verificationResult;
    if (platform === 'android') {
      verificationResult = await verifyGooglePlayPurchase(verificationData, productId);
    } else if (platform === 'ios') {
      verificationResult = await verifyAppleAppStorePurchase(verificationData);
    }

    if (!verificationResult.valid) {
      return res.status(400).json({ error: 'Purchase verification failed' });
    }

    // Calculate expiry date
    const expiryDate = new Date(verificationResult.expiryTime);

    // Create or update subscription record
    const existingSubscription = await StripeSubscription.getActiveByUserId(userId);

    const subscriptionData = {
      userId,
      stripeCustomerId: `iap_${platform}_${userId}`, // Special ID for IAP
      stripeSubscriptionId: `iap_${platform}_${purchaseId}`,
      stripePriceId: productId,
      planId,
      status: 'active',
      billingCycle,
      currentPeriodStart: new Date(),
      currentPeriodEnd: expiryDate,
      cancelAtPeriodEnd: false,
    };

    if (existingSubscription) {
      await StripeSubscription.update(existingSubscription.stripe_subscription_id, subscriptionData);
    } else {
      await StripeSubscription.create(subscriptionData);
    }

    // Update user's subscription status
    await User.update(userId, {
      plan_id: planId,
      subscription_type: billingCycle,
      subscription_status: 'active',
      subscription_started_at: new Date().toISOString(),
      subscription_expires_at: expiryDate.toISOString(),
    });

    logger.info('IAP subscription activated', { userId, platform, planId, billingCycle });

    // Send activation email
    const user = await User.getById(userId);
    await sendSubscriptionEmail(user.email, 'activated', {
      planName: plan.name,
      billingCycle,
    });

    res.json({
      success: true,
      message: 'Subscription activated',
      expiresAt: expiryDate.toISOString(),
    });
  } catch (error) {
    logger.error('Failed to activate IAP subscription', { error: error.message });
    res.status(500).json({ error: 'Failed to activate subscription' });
  }
}

// Map plan IDs to product ID names (for generating Google Play/App Store product IDs)
const PLAN_ID_TO_PRODUCT_NAME = {
  2: 'basic',
  3: 'pro',
  4: 'enterprise',
};

// Generate IAP product ID for a plan
function generateProductId(planId, cycle) {
  const planName = PLAN_ID_TO_PRODUCT_NAME[planId];
  if (!planName) return null;

  // Handle enterprise typo in Google Play Console
  if (planName === 'enterprise' && cycle === 'monthly') {
    return 'rexstream-enterprice-monthly'; // Note: typo matches Play Console
  }

  return `rexstream-${planName}-${cycle}`;
}

// Get platform-specific pricing
export async function getPlatformPricing(req, res) {
  try {
    const { platform } = req.query;

    // Get all active, non-hidden plans
    const plans = await Plan.getAll();

    // Calculate platform-specific prices and add product IDs
    const pricedPlans = plans
      .filter(plan => plan.is_active && !plan.is_hidden && plan.price_monthly > 0) // Exclude free plans from IAP
      .map((plan) => {
        const markup = PLATFORM_MARKUP[platform] || 0;
        const productIdMonthly = generateProductId(plan.id, 'monthly');
        const productIdYearly = generateProductId(plan.id, 'yearly');

        return {
          id: plan.id,
          name: plan.name,
          description: plan.description,
          price_monthly: plan.price_monthly,
          price_yearly: plan.price_yearly,
          platform_price_monthly: Math.round(plan.price_monthly * (1 + markup) * 100) / 100,
          platform_price_yearly: Math.round(plan.price_yearly * (1 + markup) * 100) / 100,
          platform_markup_percentage: markup * 100,
          platform,
          // IAP product IDs
          product_id_monthly: productIdMonthly,
          product_id_yearly: productIdYearly,
          // Plan features
          max_concurrent_streams: plan.max_concurrent_streams,
          max_bitrate: plan.max_bitrate,
          max_platform_connections: plan.max_platform_connections,
          storage_limit_mb: plan.storage_limit_mb,
          custom_watermark: plan.custom_watermark,
          youtube_restreaming: plan.youtube_restreaming,
        };
      });

    // Also return list of all valid product IDs for querying stores
    const allProductIds = pricedPlans.flatMap(plan => [
      plan.product_id_monthly,
      plan.product_id_yearly,
    ]).filter(Boolean);

    res.json({
      plans: pricedPlans,
      product_ids: allProductIds,
      platform,
    });
  } catch (error) {
    logger.error('Failed to get platform pricing', { error: error.message });
    res.status(500).json({ error: 'Failed to get pricing' });
  }
}

// Handle IAP subscription renewal webhook
// This should be called by your server-side subscription status checker
export async function handleIAPRenewal(req, res) {
  try {
    const { userId, platform, productId, expiryTime } = req.body;

    if (!userId || !platform || !productId || !expiryTime) {
      return res.status(400).json({ error: 'Missing required fields' });
    }

    const subscription = await StripeSubscription.getActiveByUserId(userId);
    if (!subscription) {
      return res.status(404).json({ error: 'Subscription not found' });
    }

    // Update subscription expiry
    await StripeSubscription.update(subscription.stripe_subscription_id, {
      currentPeriodEnd: new Date(expiryTime),
    });

    await User.update(userId, {
      subscription_expires_at: new Date(expiryTime).toISOString(),
    });

    logger.info('IAP subscription renewed', { userId, platform, expiryTime });

    res.json({ success: true, message: 'Subscription renewed' });
  } catch (error) {
    logger.error('Failed to handle IAP renewal', { error: error.message });
    res.status(500).json({ error: 'Failed to process renewal' });
  }
}

// Check IAP subscription status
export async function checkIAPStatus(req, res) {
  try {
    const userId = req.user.id;
    const { platform, purchaseToken, productId } = req.body;

    if (!platform || !purchaseToken || !productId) {
      return res.status(400).json({ error: 'Missing required fields' });
    }

    let verificationResult;

    if (platform === 'android') {
      verificationResult = await verifyGooglePlayPurchase(purchaseToken, productId);
    } else if (platform === 'ios') {
      verificationResult = await verifyAppleAppStorePurchase(purchaseToken);
    } else {
      return res.status(400).json({ error: 'Invalid platform' });
    }

    res.json({
      active: verificationResult.valid,
      expiryTime: verificationResult.expiryTime,
      autoRenewing: verificationResult.autoRenewing,
    });
  } catch (error) {
    logger.error('Failed to check IAP status', { error: error.message });
    res.status(500).json({ error: 'Failed to check status' });
  }
}
