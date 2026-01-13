import express from 'express';
import { auth, adminOnly } from '../middleware/auth.js';
import * as billingController from '../controllers/billingController.js';

const router = express.Router();

// Public endpoint for payment settings
router.get('/public-settings', billingController.getPublicSettings);

// User endpoints (require authentication)
router.post('/create-checkout-session', auth, billingController.createCheckoutSession);
router.post('/create-portal-session', auth, billingController.createPortalSession);
router.get('/subscription', auth, billingController.getSubscription);
router.get('/invoices', auth, billingController.getInvoices);
router.post('/cancel-subscription', auth, billingController.cancelSubscription);
router.post('/validate-coupon', auth, billingController.validateCoupon);
router.get('/preview-upgrade', auth, billingController.previewUpgrade);
router.post('/upgrade-plan', auth, billingController.upgradePlan);
router.get('/invoice/:invoiceId/pdf', auth, billingController.generatePdfInvoice);

// Admin endpoints
router.get('/admin/subscriptions', auth, adminOnly, billingController.getAllSubscriptions);
router.get('/admin/invoices', auth, adminOnly, billingController.getAllInvoices);
router.post('/admin/subscription/:subscriptionId/cancel', auth, adminOnly, billingController.adminCancelSubscription);
router.get('/admin/settings', auth, adminOnly, billingController.getPaymentSettings);
router.put('/admin/settings', auth, adminOnly, billingController.updatePaymentSettings);
router.post('/admin/sync-prices', auth, adminOnly, billingController.syncStripePrices);
router.get('/admin/invoice/:invoiceId/pdf', auth, adminOnly, billingController.adminGeneratePdfInvoice);

// Admin coupon endpoints
router.get('/admin/coupons', auth, adminOnly, billingController.getAllCoupons);
router.post('/admin/coupons', auth, adminOnly, billingController.createCoupon);
router.put('/admin/coupons/:id', auth, adminOnly, billingController.updateCoupon);
router.delete('/admin/coupons/:id', auth, adminOnly, billingController.deleteCoupon);
router.get('/admin/coupons/:id/redemptions', auth, adminOnly, billingController.getCouponRedemptions);

export default router;
