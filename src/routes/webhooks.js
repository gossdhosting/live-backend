import express from 'express';
import { handleStripeWebhook } from '../controllers/webhookController.js';

const router = express.Router();

// Stripe webhook endpoint
// Note: This endpoint needs raw body, not JSON parsed
// The raw body middleware should be applied in server.js before JSON middleware
router.post('/stripe', express.raw({ type: 'application/json' }), handleStripeWebhook);

export default router;
