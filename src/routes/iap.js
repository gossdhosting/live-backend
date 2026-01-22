import express from 'express';
import { auth } from '../middleware/auth.js';
import * as iapController from '../controllers/iapController.js';

const router = express.Router();

// User endpoints (require authentication)
router.post('/verify-iap', auth, iapController.verifyIAPPurchase);
router.post('/activate-iap-subscription', auth, iapController.activateIAPSubscription);
router.post('/check-iap-status', auth, iapController.checkIAPStatus);
router.post('/sync-subscription', auth, iapController.syncUserSubscription);

// Public endpoint for platform-specific pricing
router.get('/platform-pricing', iapController.getPlatformPricing);

// Webhook endpoint for renewals (should be secured with API key or signature)
router.post('/iap-renewal-webhook', iapController.handleIAPRenewal);

export default router;
