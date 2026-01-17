import User from '../models/User.js';
import Plan from '../models/Plan.js';
import StripeSubscription from '../models/StripeSubscription.js';
import Settings from '../models/Settings.js';
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

// Helper function to check if data is a StoreKit 2 JWS (starts with "ey" = base64 JSON)
function isStoreKit2JWS(data) {
  // StoreKit 2 JWS format: header.payload.signature
  // Each part is base64-encoded, and header/payload are JSON starting with '{'
  // When base64-encoded, '{' becomes 'ey'
  return typeof data === 'string' && data.startsWith('ey') && data.split('.').length === 3;
}

// Apple App Store StoreKit 2 verification (JWS)
async function verifyAppleStoreKit2Purchase(transactionJWS, transactionId) {
  try {
    // For StoreKit 2, we can verify the JWS signature locally or use App Store Server API
    // For now, we'll accept the transaction and verify basic info
    // In production, you should verify the JWS signature using Apple's public keys

    // Decode the JWS payload (middle part)
    const parts = transactionJWS.split('.');
    if (parts.length !== 3) {
      return { valid: false, error: 'Invalid JWS format' };
    }

    // Decode the payload (it's base64url encoded)
    const payload = Buffer.from(parts[1], 'base64').toString('utf8');
    const transaction = JSON.parse(payload);

    logger.info('StoreKit 2 transaction decoded', { transaction });

    // Basic validation
    if (!transaction.transactionId) {
      return { valid: false, error: 'Missing transaction ID in JWS' };
    }

    // For subscriptions, extract expiration time
    // Note: We don't reject expired subscriptions here because:
    // 1. Restored purchases include historical transactions
    // 2. We'll check expiry during activation instead
    const expiryTime = transaction.expiresDate ? parseInt(transaction.expiresDate) : 0;

    return {
      valid: true,
      expiryTime: expiryTime,
      transactionId: transaction.transactionId,
      originalTransactionId: transaction.originalTransactionId || transaction.transactionId,
      productId: transaction.productId,
      isExpired: expiryTime > 0 && expiryTime < Date.now(),
    };
  } catch (error) {
    logger.error('StoreKit 2 JWS verification failed', { error: error.message });
    return { valid: false, error: error.message };
  }
}

// Apple App Store verification (StoreKit 1 - legacy receipt verification)
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

    logger.info('Verifying IAP purchase', { userId, platform, productId, purchaseId });

    let verificationResult;

    if (platform === 'android') {
      verificationResult = await verifyGooglePlayPurchase(
        verificationData,
        productId,
        process.env.ANDROID_PACKAGE_NAME
      );
    } else if (platform === 'ios') {
      // Detect StoreKit 2 JWS vs StoreKit 1 receipt
      if (isStoreKit2JWS(verificationData)) {
        logger.info('Detected StoreKit 2 JWS transaction');
        verificationResult = await verifyAppleStoreKit2Purchase(verificationData, purchaseId);
      } else {
        logger.info('Detected StoreKit 1 receipt');
        verificationResult = await verifyAppleAppStorePurchase(verificationData);
      }
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

// Parse product ID to extract plan name and billing cycle
// Supports formats:
//   - rexstream-{planName}-{cycle} (e.g., rexstream-basic-monthly)
//   - com.rexstream.plan_{planId}_{cycle} (legacy format with plan ID)
function parseProductId(productId) {
  // Try new format: rexstream-{planName}-{cycle}
  if (productId.startsWith('rexstream-')) {
    const parts = productId.split('-');
    if (parts.length >= 3) {
      let planName = parts[1].toLowerCase();
      const cycle = parts[2];

      // Handle typo variations (e.g., 'enterprice' -> 'enterprise')
      if (planName === 'enterprice') {
        planName = 'enterprise';
      }

      return { planName, billingCycle: cycle, planId: null };
    }
  }

  // Try legacy format: com.rexstream.plan_{planId}_{cycle}
  const underscoreParts = productId.split('_');
  if (underscoreParts.length >= 3) {
    const planId = parseInt(underscoreParts[1]);
    const billingCycle = underscoreParts[2];

    if (!isNaN(planId)) {
      return { planId, billingCycle, planName: null };
    }
  }

  return null;
}

// Find plan from database based on parsed product ID info
async function findPlanFromProductId(parsedInfo) {
  if (!parsedInfo) return null;

  // If we have a plan ID, look up directly
  if (parsedInfo.planId) {
    return await Plan.getById(parsedInfo.planId);
  }

  // If we have a plan name, look up by name (case-insensitive)
  if (parsedInfo.planName) {
    return await Plan.getByName(parsedInfo.planName);
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

    // Find plan by matching productId against database product ID fields
    const plans = await Plan.getAll();
    let matchedPlan = null;
    let billingCycle = null;

    for (const plan of plans) {
      // Check Android product IDs
      if (platform === 'android') {
        if (plan.android_product_id_monthly === productId) {
          matchedPlan = plan;
          billingCycle = 'monthly';
          break;
        }
        if (plan.android_product_id_yearly === productId) {
          matchedPlan = plan;
          billingCycle = 'yearly';
          break;
        }
      }
      // Check iOS product IDs
      else if (platform === 'ios') {
        if (plan.ios_product_id_monthly === productId) {
          matchedPlan = plan;
          billingCycle = 'monthly';
          break;
        }
        if (plan.ios_product_id_yearly === productId) {
          matchedPlan = plan;
          billingCycle = 'yearly';
          break;
        }
      }
    }

    if (!matchedPlan || !billingCycle) {
      logger.error('Plan not found for product ID', { productId, platform });
      return res.status(404).json({ error: 'Plan not found for this product' });
    }

    const planId = matchedPlan.id;
    const plan = matchedPlan;

    // Verify purchase again for security
    let verificationResult;
    if (platform === 'android') {
      verificationResult = await verifyGooglePlayPurchase(verificationData, productId);
    } else if (platform === 'ios') {
      // Detect StoreKit 2 JWS vs StoreKit 1 receipt
      if (isStoreKit2JWS(verificationData)) {
        verificationResult = await verifyAppleStoreKit2Purchase(verificationData, purchaseId);
      } else {
        verificationResult = await verifyAppleAppStorePurchase(verificationData);
      }
    }

    if (!verificationResult.valid) {
      return res.status(400).json({ error: 'Purchase verification failed' });
    }

    // Check if subscription has expired
    if (verificationResult.isExpired) {
      logger.warn('Attempted to activate expired subscription', { userId, productId, purchaseId });
      return res.status(400).json({
        error: 'Subscription has expired',
        expiryTime: verificationResult.expiryTime
      });
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

// Generate IAP product ID from plan name
// Format: rexstream-{planName}-{cycle}
function generateProductIdFromPlan(planName, cycle) {
  if (!planName) return null;

  // Normalize plan name to lowercase for product ID
  let normalizedName = planName.toLowerCase().replace(/\s+/g, '-');

  // Handle typo in Google Play Console (enterprice instead of enterprise)
  // Only for monthly cycle to match existing Google Play product
  if (normalizedName === 'enterprise' && cycle === 'monthly') {
    normalizedName = 'enterprice';
  }

  return `rexstream-${normalizedName}-${cycle}`;
}

// Get platform-specific pricing
export async function getPlatformPricing(req, res) {
  try {
    const { platform } = req.query;

    // Get all plans from database
    const plans = await Plan.getAll();

    // Get IAP settings from database
    const androidProductIdSetting = await Settings.get('android_product_id');
    const iosSubscriptionGroupIdSetting = await Settings.get('ios_subscription_group_id');

    // Calculate platform-specific prices and use stored product IDs
    const pricedPlans = plans
      .filter(plan => {
        // Check if active (handle both boolean and integer values)
        const isActive = plan.is_active === true || plan.is_active === 1;
        // Check if hidden
        const isHidden = plan.is_hidden === true || plan.is_hidden === 1;
        // Exclude free plans (no IAP needed) and inactive/hidden plans
        return isActive && !isHidden && parseFloat(plan.price_monthly) > 0;
      })
      .map((plan) => {
        const markup = PLATFORM_MARKUP[platform] || 0;

        // Use stored product IDs from database based on platform
        let productIdMonthly, productIdYearly;

        if (platform === 'android') {
          productIdMonthly = plan.android_product_id_monthly;
          productIdYearly = plan.android_product_id_yearly;
        } else if (platform === 'ios') {
          productIdMonthly = plan.ios_product_id_monthly;
          productIdYearly = plan.ios_product_id_yearly;
        }

        return {
          id: plan.id,
          name: plan.name,
          description: plan.description,
          price_monthly: parseFloat(plan.price_monthly),
          price_yearly: parseFloat(plan.price_yearly),
          // Use base price (no markup) since actual store prices are set in Google Play/App Store
          platform_price_monthly: parseFloat(plan.price_monthly),
          platform_price_yearly: parseFloat(plan.price_yearly),
          platform_markup_percentage: 0, // No markup applied - using actual store prices
          platform,
          // IAP product IDs (from database, entered by admin)
          product_id_monthly: productIdMonthly || null,
          product_id_yearly: productIdYearly || null,
          // Plan features
          max_concurrent_streams: plan.max_concurrent_streams,
          max_bitrate: plan.max_bitrate,
          max_platform_connections: plan.max_platform_connections,
          storage_limit_mb: plan.storage_limit_mb,
          custom_watermark: plan.custom_watermark === true || plan.custom_watermark === 1,
          youtube_restreaming: plan.youtube_restreaming === true || plan.youtube_restreaming === 1,
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
      // Global IAP settings
      android_product_id: androidProductIdSetting?.value || null,
      ios_subscription_group_id: iosSubscriptionGroupIdSetting?.value || null,
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
