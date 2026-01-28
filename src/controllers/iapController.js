import User from '../models/User.js';
import Plan from '../models/Plan.js';
import StripeSubscription from '../models/StripeSubscription.js';
import Settings from '../models/Settings.js';
import db from '../models/database.js';
import logger from '../utils/logger.js';
import { sendSubscriptionEmail } from '../services/EmailService.js';
import OneSignalService from '../services/OneSignalService.js';

// Platform commission rates
const PLATFORM_MARKUP = {
  android: 0.43, // 43% markup to cover 30% Google Play fee
  ios: 0.43,     // 43% markup to cover 30% App Store fee
};

// Google Play verification
// Auto-detects sandbox/test purchases - no need to check payment_mode
async function verifyGooglePlayPurchase(purchaseToken, productId, packageName) {
  // Check if Google Play Developer API is configured
  const serviceAccountKeyFile = process.env.GOOGLE_SERVICE_ACCOUNT_KEY_FILE;
  const isDevelopment = process.env.NODE_ENV === 'development';

  console.log('[IAP-GOOGLE] Service account configured:', !!serviceAccountKeyFile);
  console.log('[IAP-GOOGLE] Environment:', process.env.NODE_ENV);

  // If no service account is configured
  if (!serviceAccountKeyFile) {
    // SECURITY: Only allow basic validation in development mode
    if (isDevelopment) {
      console.log('[IAP-GOOGLE] ⚠️ DEV MODE: No Google Service Account - using basic validation');
      logger.warn('Google Play verification using basic validation - DEV MODE ONLY');

      // Basic validation: check that purchase token exists and has reasonable format
      if (!purchaseToken || purchaseToken.length < 50) {
        return { valid: false, error: 'Invalid purchase token format' };
      }

      const isYearly = productId.includes('year');
      const expiryMs = isYearly
        ? Date.now() + (365 * 24 * 60 * 60 * 1000)
        : Date.now() + (30 * 24 * 60 * 60 * 1000);

      return {
        valid: true,
        expiryTime: expiryMs,
        autoRenewing: true,
        orderId: `dev_${Date.now()}`,
        isTestPurchase: true,
        basicValidation: true,
      };
    } else {
      // PRODUCTION: Reject if Google API not configured
      console.log('[IAP-GOOGLE] ❌ PRODUCTION: Google Service Account required');
      logger.error('Google Play verification failed - service account not configured in production');
      return {
        valid: false,
        error: 'Google Play API not configured. Contact support.',
      };
    }
  }

  // Full Google Play Developer API verification
  try {
    const { google } = await import('googleapis');

    // Load credentials from environment or service account file
    const auth = new google.auth.GoogleAuth({
      keyFile: serviceAccountKeyFile,
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

    // purchaseType: 0 = test (license tester), 1 = promo, undefined = real purchase
    const isTestPurchase = response.data.purchaseType === 0;

    console.log('[IAP-GOOGLE] Purchase type:', response.data.purchaseType, isTestPurchase ? '(test)' : '(real)');
    console.log('[IAP-GOOGLE] Payment state:', response.data.paymentState);

    // Auto-detect: Accept both test and real purchases
    // Log for tracking purposes
    if (isTestPurchase) {
      logger.info('Processing Google Play test purchase (license tester)', {
        purchaseType: response.data.purchaseType,
        productId
      });
    } else {
      logger.info('Processing Google Play production purchase', {
        purchaseType: response.data.purchaseType,
        productId
      });
    }

    return {
      valid: response.data.paymentState === 1, // 1 = Payment received
      expiryTime: parseInt(response.data.expiryTimeMillis),
      autoRenewing: response.data.autoRenewing,
      orderId: response.data.orderId,
      isTestPurchase: isTestPurchase,
    };
  } catch (error) {
    logger.error('Google Play verification failed', { error: error.message });

    // SECURITY: Only allow fallback in development mode
    if (isDevelopment) {
      console.log('[IAP-GOOGLE] ⚠️ DEV MODE: API call failed - using fallback');

      const isYearly = productId.includes('year');
      const expiryMs = isYearly
        ? Date.now() + (365 * 24 * 60 * 60 * 1000)
        : Date.now() + (30 * 24 * 60 * 60 * 1000);

      return {
        valid: true,
        expiryTime: expiryMs,
        autoRenewing: true,
        orderId: `dev_fallback_${Date.now()}`,
        isTestPurchase: true,
        basicValidation: true,
      };
    }

    // PRODUCTION: Return the actual error
    console.log('[IAP-GOOGLE] ❌ PRODUCTION: Verification failed');
    return { valid: false, error: `Google Play verification failed: ${error.message}` };
  }
}

// Helper function to check if data is a StoreKit 2 JWS (starts with "ey" = base64 JSON)
function isStoreKit2JWS(data) {
  // StoreKit 2 JWS format: header.payload.signature
  // Each part is base64-encoded, and header/payload are JSON starting with '{'
  // When base64-encoded, '{' becomes 'ey'
  return typeof data === 'string' && data.startsWith('ey') && data.split('.').length === 3;
}

// Cache for Apple's public keys (refreshed every 24 hours)
let applePublicKeysCache = null;
let applePublicKeysCacheTime = 0;
const APPLE_KEYS_CACHE_DURATION = 24 * 60 * 60 * 1000; // 24 hours

// Fetch Apple's public keys for JWS verification
async function getApplePublicKeys() {
  const now = Date.now();

  // Return cached keys if still valid
  if (applePublicKeysCache && (now - applePublicKeysCacheTime) < APPLE_KEYS_CACHE_DURATION) {
    return applePublicKeysCache;
  }

  try {
    const https = await import('https');

    const response = await new Promise((resolve, reject) => {
      https.get('https://appleid.apple.com/auth/keys', (res) => {
        let data = '';
        res.on('data', (chunk) => data += chunk);
        res.on('end', () => {
          try {
            resolve(JSON.parse(data));
          } catch (e) {
            reject(new Error('Failed to parse Apple public keys'));
          }
        });
      }).on('error', reject);
    });

    if (response && response.keys) {
      applePublicKeysCache = response.keys;
      applePublicKeysCacheTime = now;
      console.log('[IAP-APPLE] ✅ Fetched Apple public keys:', response.keys.length, 'keys');
      return response.keys;
    }

    throw new Error('Invalid response from Apple keys endpoint');
  } catch (error) {
    logger.error('Failed to fetch Apple public keys', { error: error.message });
    // Return cached keys if available, even if expired
    if (applePublicKeysCache) {
      logger.warn('Using expired Apple public keys cache');
      return applePublicKeysCache;
    }
    throw error;
  }
}

// Convert JWK to PEM format for signature verification
function jwkToPem(jwk) {
  const crypto = require('crypto');

  // Create a KeyObject from JWK
  const keyObject = crypto.createPublicKey({
    key: jwk,
    format: 'jwk'
  });

  // Export as PEM
  return keyObject.export({
    type: 'spki',
    format: 'pem'
  });
}

// Verify Apple JWS signature using Apple's public keys
async function verifyAppleJWSSignature(jws) {
  const isDevelopment = process.env.NODE_ENV === 'development';

  try {
    const parts = jws.split('.');
    if (parts.length !== 3) {
      return { valid: false, error: 'Invalid JWS format' };
    }

    // Decode header to get key ID (kid)
    const headerB64 = parts[0];
    const header = JSON.parse(Buffer.from(headerB64, 'base64').toString('utf8'));

    console.log('[IAP-JWS] Algorithm:', header.alg);
    console.log('[IAP-JWS] Key ID:', header.kid);

    // Apple uses ES256 algorithm
    if (header.alg !== 'ES256') {
      logger.warn('Unexpected JWS algorithm', { algorithm: header.alg });
    }

    // Decode payload first (we'll verify signature after)
    const payloadB64 = parts[1];
    const payload = JSON.parse(Buffer.from(payloadB64, 'base64').toString('utf8'));

    // SECURITY: Verify signature using Apple's public keys
    try {
      const jwt = await import('jsonwebtoken');
      const appleKeys = await getApplePublicKeys();

      // Find the key matching the kid in the header
      const signingKey = appleKeys.find(key => key.kid === header.kid);

      if (!signingKey) {
        logger.error('Apple signing key not found', { kid: header.kid });

        // In development, allow without signature verification but warn
        if (isDevelopment) {
          console.log('[IAP-JWS] ⚠️ DEV MODE: Signing key not found, proceeding without verification');
        } else {
          return { valid: false, error: 'Apple signing key not found' };
        }
      } else {
        // Convert JWK to PEM and verify
        const pem = jwkToPem(signingKey);

        // Verify the JWT signature
        jwt.default.verify(jws, pem, {
          algorithms: ['ES256'],
          complete: true
        });

        console.log('[IAP-JWS] ✅ Signature verified successfully');
      }
    } catch (verifyError) {
      logger.error('JWS signature verification failed', { error: verifyError.message });

      // SECURITY: Only allow unverified in development
      if (isDevelopment) {
        console.log('[IAP-JWS] ⚠️ DEV MODE: Signature verification failed, proceeding anyway');
        console.log('[IAP-JWS] Error:', verifyError.message);
      } else {
        return { valid: false, error: `Signature verification failed: ${verifyError.message}` };
      }
    }

    // Validate bundle ID if configured
    if (payload.bundleId && process.env.IOS_BUNDLE_ID) {
      if (payload.bundleId !== process.env.IOS_BUNDLE_ID) {
        return { valid: false, error: 'Bundle ID mismatch' };
      }
    }

    // Auto-detect sandbox vs production from the receipt itself
    const isReceiptSandbox = payload.environment && payload.environment !== 'Production';

    console.log('[IAP-JWS] Receipt environment:', payload.environment);
    console.log('[IAP-JWS] Is sandbox receipt:', isReceiptSandbox);

    // Log for tracking purposes but allow both environments
    if (isReceiptSandbox) {
      logger.info('Processing iOS sandbox receipt', {
        receiptEnvironment: payload.environment,
        transactionId: payload.transactionId
      });
    } else {
      logger.info('Processing iOS production receipt', {
        receiptEnvironment: payload.environment,
        transactionId: payload.transactionId
      });
    }

    return { valid: true, payload, header };
  } catch (error) {
    logger.error('JWS verification failed', { error: error.message });
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

/**
 * Handle IAP renewal failure
 * Called when App Store/Google Play reports a subscription renewal failure
 */
export async function handleIAPRenewalFailure(req, res) {
  try {
    const { userId, platform, productId, reason } = req.body;

    console.log('[IAP-RENEWAL-FAILURE] 📛 Renewal failed for user', userId);
    console.log('[IAP-RENEWAL-FAILURE] Platform:', platform);
    console.log('[IAP-RENEWAL-FAILURE] Product ID:', productId);
    console.log('[IAP-RENEWAL-FAILURE] Reason:', reason);

    if (!userId) {
      return res.status(400).json({ error: 'Missing userId' });
    }

    const user = await User.getById(userId);
    if (!user) {
      return res.status(404).json({ error: 'User not found' });
    }

    const subscription = await StripeSubscription.getActiveByUserId(userId);
    if (!subscription) {
      console.log('[IAP-RENEWAL-FAILURE] No active subscription found');
      return res.status(404).json({ error: 'Subscription not found' });
    }

    // Mark subscription as past_due (grace period)
    console.log('[IAP-RENEWAL-FAILURE] Marking subscription as past_due');
    await StripeSubscription.update(subscription.stripe_subscription_id, {
      status: 'past_due',
    });

    await User.update(userId, {
      subscription_status: 'past_due',
    });

    logger.warn('IAP subscription renewal failed - marked as past_due', {
      userId,
      platform,
      productId,
      reason,
      subscriptionId: subscription.stripe_subscription_id
    });

    // Send email notification to user
    try {
      await sendSubscriptionEmail(user.email, 'payment_failed', {
        name: user.name,
        planId: subscription.plan_id,
        reason: reason || 'Payment method declined'
      });
      console.log('[IAP-RENEWAL-FAILURE] Email notification sent to user');
    } catch (emailError) {
      logger.error('Failed to send renewal failure email', {
        error: emailError.message,
        userId
      });
    }

    console.log('[IAP-RENEWAL-FAILURE] ✅ Renewal failure processed');
    res.json({ success: true, message: 'Renewal failure processed' });
  } catch (error) {
    console.error('[IAP-RENEWAL-FAILURE] ❌ Error:', error.message);
    logger.error('Failed to handle IAP renewal failure', { error: error.message });
    res.status(500).json({ error: 'Failed to process renewal failure' });
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

    // Send OneSignal push notification
    try {
      const plan = await Plan.findById(subscription.plan_id);
      const playerId = await User.getOneSignalPlayerId(userId);
      if (playerId && plan) {
        await OneSignalService.notifySubscriptionRenewed(playerId, plan.name);
      }
    } catch (pushError) {
      logger.error('Failed to send renewal push notification', { error: pushError.message });
    }

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
      console.log('[IAP-SYNC] 📝 Note: User plan_id is:', user.plan_id, '(keeping as is - admin may have set manually)');

      // No active subscription found
      // DO NOT auto-downgrade - admin might have manually set the plan
      // Let the cron job (check-expired-subscriptions.js) handle expiry downgrades
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

    // NOTE: users.plan_id is the ONLY source of truth
    // stripe_subscriptions.plan_id is ONLY for payment tracking
    // We do NOT sync plan_id from subscription to user

    console.log('[IAP-SYNC] 📝 Note: Subscription plan_id is:', activeSub.plan_id, '(used for payment tracking only)');
    console.log('[IAP-SYNC] 📝 User plan_id is:', user.plan_id, '(source of truth for features)');

    // Update subscription metadata (expiry date, status, billing cycle) but NOT plan_id
    let needsUpdate = false;
    const updates = {};

    if (user.subscription_expires_at !== activeSub.current_period_end.toISOString()) {
      console.log('[IAP-SYNC] 📅 Updating subscription expiry date');
      updates.subscription_expires_at = activeSub.current_period_end.toISOString();
      needsUpdate = true;
    }

    const newStatus = activeSub.status === 'active' || activeSub.status === 'trialing' ? 'active' : 'cancelled';
    if (user.subscription_status !== newStatus) {
      console.log('[IAP-SYNC] 📊 Updating subscription status');
      updates.subscription_status = newStatus;
      needsUpdate = true;
    }

    if (user.subscription_type !== activeSub.billing_cycle) {
      console.log('[IAP-SYNC] 🔄 Updating billing cycle');
      updates.subscription_type = activeSub.billing_cycle;
      needsUpdate = true;
    }

    if (needsUpdate) {
      await User.update(userId, updates);
      console.log('[IAP-SYNC] ✅ Subscription metadata updated (plan_id unchanged)');
    }

    console.log('[IAP-SYNC] ✅ Sync complete');
    res.json({
      synced: true,
      changed: needsUpdate,
      plan_id: user.plan_id, // Return user's actual plan_id (source of truth)
      expires_at: activeSub.current_period_end,
      reason: needsUpdate ? 'metadata_updated' : 'already_in_sync'
    });

  } catch (error) {
    console.log('[IAP-SYNC] ❌ Sync failed:', error.message);
    logger.error('Failed to sync user subscription', { error: error.message, userId: req.user.id });
    res.status(500).json({ error: 'Failed to sync subscription' });
  }
}
