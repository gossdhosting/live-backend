import express from 'express';
import { authenticateToken, requireAdmin } from '../middleware/auth.js';
import {
  // User endpoints
  getUserCredit,
  getCreditHistory,
  // Admin endpoints
  getAllTransactions,
  getCreditStats,
  getUsersWithCredits,
  adjustUserCredit,
  getUserCreditDetails,
} from '../controllers/creditController.js';

const router = express.Router();

// =====================
// User Routes (authenticated)
// =====================

// Get current user's credit balance
router.get('/balance', authenticateToken, getUserCredit);

// Get user's credit transaction history
router.get('/history', authenticateToken, getCreditHistory);

// =====================
// Admin Routes
// =====================

// Get all credit transactions
router.get('/admin/transactions', authenticateToken, requireAdmin, getAllTransactions);

// Get credit statistics
router.get('/admin/stats', authenticateToken, requireAdmin, getCreditStats);

// Get users with credit balances
router.get('/admin/users', authenticateToken, requireAdmin, getUsersWithCredits);

// Get specific user's credit details
router.get('/admin/users/:userId', authenticateToken, requireAdmin, getUserCreditDetails);

// Adjust user credit (add or deduct)
router.post('/admin/adjust', authenticateToken, requireAdmin, adjustUserCredit);

export default router;
