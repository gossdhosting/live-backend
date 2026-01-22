import User from '../models/User.js';
import Plan from '../models/Plan.js';
import StripeSubscription from '../models/StripeSubscription.js';
import Settings from '../models/Settings.js';
import db from '../models/database.js';
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

// Verify Apple JWS signature using Apple's public keys
async function verifyAppleJWSSignature(jws) {
  try {
    // In production, you should:
    // 1. Fetch Apple's public keys from: https://appleid.apple.com/auth/keys
    // 2. Cache the keys and refresh periodically
    // 3. Use a JWT library like 'jsonwebtoken' or 'node-jose' to verify signature

    // For now, we'll do basic validation without signature verification
    // TODO: Implement proper signature verification for production

    const parts = jws.split('.');
    if (parts.length !== 3) {
      return { valid: false, error: 'Invalid JWS format' };
    }

    // Decode header to check algorithm
    const headerB64 = parts[0];
    const header = JSON.parse(Buffer.from(headerB64, 'base64').toString('utf8'));

    // Apple uses ES256 algorithm
    if (header.alg !== 'ES256') {
      logger.warn('Unexpected JWS algorithm', { algorithm: header.alg });
    }

    // Decode payload
    const payloadB64 = parts[1];
    const payload = JSON.parse(Buffer.from(payloadB64, 'base64').toString('utf8'));

    // Validate bundle ID if available
    if (payload.bundleId && process.env.IOS_BUNDLE_ID) {
      if (payload.bundleId !== process.env.IOS_BUNDLE_ID) {
        return { valid: false, error: 'Bundle ID mismatch' };
      }
    }

    // Validate environment (should be Production in live app)
    if (payload.environment && process.env.NODE_ENV === 'production') {
      if (payload.environment !== 'Production') {
        logger.warn('Sandbox receipt used in production', { environment: payload.environment });
        // Allow sandbox in non-production for testing
        if (process.env.NODE_ENV === 'production') {
          return { valid: false, error: 'Sandbox receipt not allowed in production' };
        }
      }
    }

    return { valid: true, payload, header };
  } catch (error) {
    logger.error('JWS signature verification failed', { error: error.message });
    return { valid: false, error: error.message };
  }
}

// Apple App Store StoreKit 2 verification (JWS)
async function verifyAppleStoreKit2Purchase(transactionJWS, transactionId) {
  try {
    // Step 1: Verify JWS signature and extract payload
    const verificationResult = await verifyAppleJWSSignature(transactionJWS);

    if (!verificationResult.valid) {
      logger.error('JWS signature verification failed', { error: verificationResult.error });
      return { valid: false, error: verificationResult.error };
    }

    const transaction = verificationResult.payload;

    logger.info('StoreKit 2 transaction verified', {
      transactionId: transaction.transactionId,
      productId: transaction.productId,
      environment: transaction.environment
    });

    // Basic validation
    if (!transaction.transactionId) {
      return { valid: false, error: 'Missing transaction ID in JWS' };
    }

    // Validate transaction ID matches if provided
    if (transactionId && transaction.transactionId !== transactionId) {
      return { valid: false, error: 'Transaction ID mismatch' };
    }

    // For subscriptions, extract expiration time
    // Note: We don't reject expired subscriptions here because:
    // 1. Restored purchases include historical transactions
    // 2. We'll check expiry during activation instead
    const expiryTime = transaction.expiresDate ? parseInt(transaction.expiresDate) : 0;

    // Check for fraud indicators
    if (transaction.originalTransactionId) {
      // TODO: Store and check if this originalTransactionId was already used by another user
      // This prevents users from sharing purchase receipts
    }

    return {
      valid: true,
      expiryTime: expiryTime,
      transactionId: transaction.transactionId,
      originalTransactionId: transaction.originalTransactionId || transaction.transactionId,
      productId: transaction.productId,
      isExpired: expiryTime > 0 && expiryTime < Date.now(),
      environment: transaction.environment,
      purchaseDate: transaction.purchaseDate,
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

    console.log('[IAP-VERIFY] 🔍 Step 1: Request received');
    console.log('[IAP-VERIFY] User ID:', userId);
    console.log('[IAP-VERIFY] Platform:', platform);
    console.log('[IAP-VERIFY] Product ID:', productId);
    console.log('[IAP-VERIFY] Purchase ID:', purchaseId);
    console.log('[IAP-VERIFY] Verification Data Length:', verificationData?.length || 0);

    if (!platform || !productId || !verificationData) {
      console.log('[IAP-VERIFY] ❌ Missing required fields');
      console.log('[IAP-VERIFY] Has platform:', !!platform);
      console.log('[IAP-VERIFY] Has productId:', !!productId);
      console.log('[IAP-VERIFY] Has verificationData:', !!verificationData);
      return res.status(400).json({ error: 'Missing required fields' });
    }

    logger.info('Verifying IAP purchase', { userId, platform, productId, purchaseId });

    let verificationResult;

    if (platform === 'android') {
      console.log('[IAP-VERIFY] 🤖 Step 2: Android verification starting');
      console.log('[IAP-VERIFY] Package name:', process.env.ANDROID_PACKAGE_NAME);
      verificationResult = await verifyGooglePlayPurchase(
        verificationData,
        productId,
        process.env.ANDROID_PACKAGE_NAME
      );
      console.log('[IAP-VERIFY] Android verification result:', JSON.stringify(verificationResult, null, 2));
    } else if (platform === 'ios') {
      console.log('[IAP-VERIFY] 🍎 Step 2: iOS verification starting');
      // Detect StoreKit 2 JWS vs StoreKit 1 receipt
      if (isStoreKit2JWS(verificationData)) {
        console.log('[IAP-VERIFY] Detected StoreKit 2 JWS transaction');
        logger.info('Detected StoreKit 2 JWS transaction');
        verificationResult = await verifyAppleStoreKit2Purchase(verificationData, purchaseId);
        console.log('[IAP-VERIFY] StoreKit 2 verification result:', JSON.stringify(verificationResult, null, 2));
      } else {
        console.log('[IAP-VERIFY] Detected StoreKit 1 receipt');
        logger.info('Detected StoreKit 1 receipt');
        verificationResult = await verifyAppleAppStorePurchase(verificationData);
        console.log('[IAP-VERIFY] StoreKit 1 verification result:', JSON.stringify(verificationResult, null, 2));
      }
    } else {
      console.log('[IAP-VERIFY] ❌ Invalid platform:', platform);
      return res.status(400).json({ error: 'Invalid platform' });
    }

    if (!verificationResult.valid) {
      console.log('[IAP-VERIFY] ❌ Step 3: Verification failed');
      console.log('[IAP-VERIFY] Error:', verificationResult.error);
      logger.warn('IAP verification failed', { userId, platform, error: verificationResult.error });
      return res.json({ verified: false, error: verificationResult.error });
    }

    console.log('[IAP-VERIFY] ✅ Step 3: Verification successful');
    console.log('[IAP-VERIFY] Expiry time:', verificationResult.expiryTime);
    console.log('[IAP-VERIFY] Transaction ID:', verificationResult.transactionId || verificationResult.orderId);
    logger.info('IAP purchase verified', { userId, platform, productId });

    res.json({
      verified: true,
      expiryTime: verificationResult.expiryTime,
      transactionId: verificationResult.transactionId || verificationResult.orderId,
    });
  } catch (error) {
    console.log('[IAP-VERIFY] ❌ Exception occurred');
    console.log('[IAP-VERIFY] Error:', error.message);
    console.log('[IAP-VERIFY] Stack:', error.stack);
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

    console.log('[IAP-ACTIVATE] 🚀 Step 1: Activation request received');
    console.log('[IAP-ACTIVATE] User ID:', userId);
    console.log('[IAP-ACTIVATE] Platform:', platform);
    console.log('[IAP-ACTIVATE] Product ID:', productId);
    console.log('[IAP-ACTIVATE] Purchase ID:', purchaseId);

    if (!platform || !productId || !verificationData) {
      console.log('[IAP-ACTIVATE] ❌ Missing required fields');
      return res.status(400).json({ error: 'Missing required fields' });
    }

    console.log('[IAP-ACTIVATE] 📋 Step 2: Finding plan for product ID');
    // Find plan by matching productId against database product ID fields
    const plans = await Plan.getAll();
    console.log('[IAP-ACTIVATE] Total plans in database:', plans.length);

    let matchedPlan = null;
    let billingCycle = null;

    for (const plan of plans) {
      console.log(`[IAP-ACTIVATE] Checking plan: ${plan.name} (ID: ${plan.id})`);
      console.log(`[IAP-ACTIVATE] - Android Monthly: ${plan.android_product_id_monthly}`);
      console.log(`[IAP-ACTIVATE] - Android Yearly: ${plan.android_product_id_yearly}`);
      console.log(`[IAP-ACTIVATE] - iOS Monthly: ${plan.ios_product_id_monthly}`);
      console.log(`[IAP-ACTIVATE] - iOS Yearly: ${plan.ios_product_id_yearly}`);

      // Check Android product IDs
      if (platform === 'android') {
        if (plan.android_product_id_monthly === productId) {
          matchedPlan = plan;
          billingCycle = 'monthly';
          console.log(`[IAP-ACTIVATE] ✅ Match found! Android monthly plan: ${plan.name}`);
          break;
        }
        if (plan.android_product_id_yearly === productId) {
          matchedPlan = plan;
          billingCycle = 'yearly';
          console.log(`[IAP-ACTIVATE] ✅ Match found! Android yearly plan: ${plan.name}`);
          break;
        }
      }
      // Check iOS product IDs
      else if (platform === 'ios') {
        if (plan.ios_product_id_monthly === productId) {
          matchedPlan = plan;
          billingCycle = 'monthly';
          console.log(`[IAP-ACTIVATE] ✅ Match found! iOS monthly plan: ${plan.name}`);
          break;
        }
        if (plan.ios_product_id_yearly === productId) {
          matchedPlan = plan;
          billingCycle = 'yearly';
          console.log(`[IAP-ACTIVATE] ✅ Match found! iOS yearly plan: ${plan.name}`);
          break;
        }
      }
    }

    if (!matchedPlan || !billingCycle) {
      console.log('[IAP-ACTIVATE] ❌ No matching plan found for product ID:', productId);
      console.log('[IAP-ACTIVATE] Platform:', platform);
      logger.error('Plan not found for product ID', { productId, platform });
      return res.status(404).json({ error: 'Plan not found for this product' });
    }

    console.log('[IAP-ACTIVATE] ✅ Step 3: Plan matched');
    console.log('[IAP-ACTIVATE] Plan ID:', matchedPlan.id);
    console.log('[IAP-ACTIVATE] Plan Name:', matchedPlan.name);
    console.log('[IAP-ACTIVATE] Billing Cycle:', billingCycle);

    const planId = matchedPlan.id;
    const plan = matchedPlan;

    console.log('[IAP-ACTIVATE] 🔐 Step 4: Re-verifying purchase for security');
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

    console.log('[IAP-ACTIVATE] Verification result:', JSON.stringify(verificationResult, null, 2));

    if (!verificationResult.valid) {
      console.log('[IAP-ACTIVATE] ❌ Purchase verification failed');
      return res.status(400).json({ error: 'Purchase verification failed' });
    }

    // Check if subscription has expired
    if (verificationResult.isExpired) {
      console.log('[IAP-ACTIVATE] ❌ Subscription has expired');
      console.log('[IAP-ACTIVATE] Expiry time:', verificationResult.expiryTime);
      logger.warn('Attempted to activate expired subscription', { userId, productId, purchaseId });
      return res.status(400).json({
        error: 'Subscription has expired',
        expiryTime: verificationResult.expiryTime
      });
    }

    console.log('[IAP-ACTIVATE] ✅ Step 5: Purchase verified and not expired');
    // Calculate expiry date
    const expiryDate = new Date(verificationResult.expiryTime);
    console.log('[IAP-ACTIVATE] Expiry date:', expiryDate.toISOString());

    console.log('[IAP-ACTIVATE] 👤 Step 6: Getting user and checking customer record');
    // Get user for email
    const user = await User.getById(userId);
    console.log('[IAP-ACTIVATE] User email:', user.email);

    // Check if user already has a stripe_customers record (from Stripe web or IAP)
    const existingUserCustomer = await db.query(
      'SELECT * FROM stripe_customers WHERE user_id = $1',
      [userId]
    );

    let customerIdToUse;

    if (existingUserCustomer.rows.length > 0) {
      // User already has a customer record (from Stripe web payments)
      // Use the existing customer ID
      customerIdToUse = existingUserCustomer.rows[0].stripe_customer_id;
      console.log('[IAP-ACTIVATE] ✅ Using existing customer record:', customerIdToUse);
      logger.info('Using existing customer record for IAP subscription', {
        userId,
        existingCustomerId: customerIdToUse
      });
    } else {
      // No existing customer record - create a new IAP customer
      const iapCustomerId = `iap_${platform}_${userId}`;
      console.log('[IAP-ACTIVATE] ✅ Creating new IAP customer record:', iapCustomerId);
      await db.query(
        `INSERT INTO stripe_customers (user_id, stripe_customer_id, email)
         VALUES ($1, $2, $3)`,
        [userId, iapCustomerId, user.email]
      );
      customerIdToUse = iapCustomerId;
      logger.info('Created new IAP customer record', { userId, iapCustomerId });
    }

    console.log('[IAP-ACTIVATE] 💾 Step 7: Creating/updating subscription record');
    // Create or update subscription record
    const existingSubscription = await StripeSubscription.getActiveByUserId(userId);
    console.log('[IAP-ACTIVATE] Existing subscription:', existingSubscription ? 'Found' : 'Not found');

    const subscriptionData = {
      userId,
      stripeCustomerId: customerIdToUse,
      stripeSubscriptionId: `iap_${platform}_${purchaseId}`,
      stripePriceId: productId,
      planId,
      status: 'active',
      billingCycle,
      currentPeriodStart: new Date(),
      currentPeriodEnd: expiryDate,
      cancelAtPeriodEnd: false,
    };

    console.log('[IAP-ACTIVATE] Subscription data:', JSON.stringify(subscriptionData, null, 2));

    if (existingSubscription) {
      console.log('[IAP-ACTIVATE] Updating existing subscription');
      await StripeSubscription.update(existingSubscription.stripe_subscription_id, subscriptionData);
    } else {
      console.log('[IAP-ACTIVATE] Creating new subscription');
      await StripeSubscription.create(subscriptionData);
    }

    console.log('[IAP-ACTIVATE] 📝 Step 8: Updating user record');
    // Update user's subscription status
    await User.update(userId, {
      plan_id: planId,
      subscription_type: billingCycle,
      subscription_status: 'active',
      subscription_started_at: new Date().toISOString(),
      subscription_expires_at: expiryDate.toISOString(),
    });

    console.log('[IAP-ACTIVATE] ✅ User record updated');
    logger.info('IAP subscription activated', { userId, platform, planId, billingCycle });

    console.log('[IAP-ACTIVATE] 📧 Step 9: Sending activation email');
    // Send activation email
    try {
      await sendSubscriptionEmail(user.email, 'activated', {
        planName: plan.name,
        billingCycle,
      });
      console.log('[IAP-ACTIVATE] ✅ Email sent successfully');
    } catch (emailError) {
      console.log('[IAP-ACTIVATE] ⚠️ Email sending failed (non-critical):', emailError.message);
      // Don't fail the whole activation if email fails
    }

    console.log('[IAP-ACTIVATE] 🎉 Step 10: Activation complete!');
    res.json({
      success: true,
      message: 'Subscription activated',
      expiresAt: expiryDate.toISOString(),
    });
  } catch (error) {
    console.log('[IAP-ACTIVATE] ❌ EXCEPTION occurred in activation');
    console.log('[IAP-ACTIVATE] Error message:', error.message);
    console.log('[IAP-ACTIVATE] Error stack:', error.stack);
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

    console.log('[IAP-PRICING] 💰 Request received');
    console.log('[IAP-PRICING] Platform:', platform);

    // Get all plans from database
    const plans = await Plan.getAll();
    console.log('[IAP-PRICING] Total plans from database:', plans.length);

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

    console.log('[IAP-PRICING] Filtered plans (active, not hidden, paid):', pricedPlans.length);
    pricedPlans.forEach(plan => {
      console.log(`[IAP-PRICING] Plan: ${plan.name} (ID: ${plan.id})`);
      console.log(`[IAP-PRICING] - Monthly product ID: ${plan.product_id_monthly}`);
      console.log(`[IAP-PRICING] - Yearly product ID: ${plan.product_id_yearly}`);
    });

    // Also return list of all valid product IDs for querying stores
    const allProductIds = pricedPlans.flatMap(plan => [
      plan.product_id_monthly,
      plan.product_id_yearly,
    ]).filter(Boolean);

    console.log('[IAP-PRICING] Total product IDs:', allProductIds.length);
    console.log('[IAP-PRICING] Product IDs:', allProductIds);
    console.log('[IAP-PRICING] Android Product ID setting:', androidProductIdSetting?.value);
    console.log('[IAP-PRICING] iOS Subscription Group ID setting:', iosSubscriptionGroupIdSetting?.value);

    res.json({
      plans: pricedPlans,
      product_ids: allProductIds,
      platform,
      // Global IAP settings
      android_product_id: androidProductIdSetting?.value || null,
      ios_subscription_group_id: iosSubscriptionGroupIdSetting?.value || null,
    });
  } catch (error) {
    console.log('[IAP-PRICING] ❌ Error occurred');
    console.log('[IAP-PRICING] Error message:', error.message);
    console.log('[IAP-PRICING] Error stack:', error.stack);
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

/**
 * Sync user's plan with their active subscription
 * This endpoint should be called on app launch to ensure plan_id consistency
 */
export async function syncUserSubscription(req, res) {
  try {
    const userId = req.user.id;

    console.log('[IAP-SYNC] 🔄 Step 1: Sync request received for user', userId);
    logger.info('Syncing user subscription', { userId });

    // Get user's current plan
    const user = await User.getById(userId);
    console.log('[IAP-SYNC] Current user plan_id:', user.plan_id);
    console.log('[IAP-SYNC] Current subscription_status:', user.subscription_status);
    console.log('[IAP-SYNC] Current subscription_expires_at:', user.subscription_expires_at);

    // Get user's active subscription from stripe_subscriptions table
    const activeSub = await StripeSubscription.getActiveByUserId(userId);

    if (!activeSub) {
      console.log('[IAP-SYNC] ❌ No active subscription found');

      // Check if subscription has expired
      if (user.subscription_expires_at) {
        const expiryDate = new Date(user.subscription_expires_at);
        const now = new Date();

        if (expiryDate < now) {
          console.log('[IAP-SYNC] ⏰ Subscription expired on', expiryDate.toISOString());

          // Downgrade to Free plan
          const freePlan = await Plan.getByName('Free');
          if (freePlan) {
            console.log('[IAP-SYNC] ⬇️ Downgrading user to Free plan');
            await User.update(userId, {
              plan_id: freePlan.id,
              subscription_status: 'expired'
            });

            logger.info('User downgraded to Free plan due to expired subscription', { userId });

            return res.json({
              synced: true,
              changed: true,
              old_plan_id: user.plan_id,
              new_plan_id: freePlan.id,
              reason: 'subscription_expired',
              expires_at: user.subscription_expires_at
            });
          }
        }
      }

      // No active subscription and not expired - keep current plan
      console.log('[IAP-SYNC] ✅ No changes needed (no active subscription)');
      return res.json({
        synced: true,
        changed: false,
        plan_id: user.plan_id,
        reason: 'no_active_subscription'
      });
    }

    console.log('[IAP-SYNC] 📋 Active subscription found:');
    console.log('[IAP-SYNC] - Subscription ID:', activeSub.stripe_subscription_id);
    console.log('[IAP-SYNC] - Plan ID:', activeSub.plan_id);
    console.log('[IAP-SYNC] - Status:', activeSub.status);
    console.log('[IAP-SYNC] - Billing Cycle:', activeSub.billing_cycle);
    console.log('[IAP-SYNC] - Expires:', activeSub.current_period_end);

    // Check if user's plan matches subscription plan
    if (activeSub.plan_id !== user.plan_id) {
      console.log('[IAP-SYNC] ⚠️ Plan mismatch detected!');
      console.log('[IAP-SYNC] - User plan_id:', user.plan_id);
      console.log('[IAP-SYNC] - Subscription plan_id:', activeSub.plan_id);
      console.log('[IAP-SYNC] - Syncing user plan to match subscription...');

      // Update user's plan to match subscription
      await User.update(userId, {
        plan_id: activeSub.plan_id,
        subscription_type: activeSub.billing_cycle,
        subscription_status: activeSub.status === 'active' || activeSub.status === 'trialing' ? 'active' : 'cancelled',
        subscription_expires_at: activeSub.current_period_end.toISOString()
      });

      console.log('[IAP-SYNC] ✅ User plan synced successfully');
      logger.info('User plan synced with active subscription', {
        userId,
        oldPlanId: user.plan_id,
        newPlanId: activeSub.plan_id
      });

      return res.json({
        synced: true,
        changed: true,
        old_plan_id: user.plan_id,
        new_plan_id: activeSub.plan_id,
        subscription_id: activeSub.stripe_subscription_id,
        expires_at: activeSub.current_period_end,
        reason: 'plan_mismatch_corrected'
      });
    }

    // Plans already match - just update expiry date if needed
    if (user.subscription_expires_at !== activeSub.current_period_end.toISOString()) {
      console.log('[IAP-SYNC] 📅 Updating subscription expiry date');
      await User.update(userId, {
        subscription_expires_at: activeSub.current_period_end.toISOString(),
        subscription_type: activeSub.billing_cycle,
        subscription_status: activeSub.status === 'active' || activeSub.status === 'trialing' ? 'active' : 'cancelled'
      });
    }

    console.log('[IAP-SYNC] ✅ Sync complete - plans already match');
    res.json({
      synced: true,
      changed: false,
      plan_id: activeSub.plan_id,
      expires_at: activeSub.current_period_end,
      reason: 'already_in_sync'
    });

  } catch (error) {
    console.log('[IAP-SYNC] ❌ Sync failed:', error.message);
    logger.error('Failed to sync user subscription', { error: error.message, userId: req.user.id });
    res.status(500).json({ error: 'Failed to sync subscription' });
  }
}
