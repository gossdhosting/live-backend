import Credit, { TRANSACTION_TYPES, REFERENCE_TYPES } from '../models/Credit.js';
import User from '../models/User.js';
import logger from '../utils/logger.js';

// =====================
// User Endpoints
// =====================

/**
 * Get current user's credit balance
 */
export const getUserCredit = async (req, res) => {
  try {
    const userId = req.user.id;
    const balance = await Credit.getBalance(userId);

    res.json({
      balance: parseFloat(balance),
      currency: 'USD',
    });
  } catch (error) {
    logger.error('Failed to get user credit', { error: error.message, userId: req.user.id });
    res.status(500).json({ error: 'Failed to get credit balance' });
  }
};

/**
 * Get user's credit transaction history
 */
export const getCreditHistory = async (req, res) => {
  try {
    const userId = req.user.id;
    const { limit = 50, offset = 0 } = req.query;

    const transactions = await Credit.getTransactionHistory(userId, parseInt(limit), parseInt(offset));
    const total = await Credit.getTransactionCount(userId);

    res.json({
      transactions,
      total,
      limit: parseInt(limit),
      offset: parseInt(offset),
    });
  } catch (error) {
    logger.error('Failed to get credit history', { error: error.message, userId: req.user.id });
    res.status(500).json({ error: 'Failed to get transaction history' });
  }
};

// =====================
// Admin Endpoints
// =====================

/**
 * Get all credit transactions (admin)
 */
export const getAllTransactions = async (req, res) => {
  try {
    const { limit = 100, offset = 0, userId, transactionType, startDate, endDate } = req.query;

    const transactions = await Credit.getAllTransactions(
      parseInt(limit),
      parseInt(offset),
      {
        userId: userId ? parseInt(userId) : null,
        transactionType,
        startDate,
        endDate,
      }
    );

    res.json({
      transactions,
      limit: parseInt(limit),
      offset: parseInt(offset),
    });
  } catch (error) {
    logger.error('Failed to get all transactions', { error: error.message });
    res.status(500).json({ error: 'Failed to get transactions' });
  }
};

/**
 * Get credit statistics (admin)
 */
export const getCreditStats = async (req, res) => {
  try {
    const stats = await Credit.getStats();
    res.json(stats);
  } catch (error) {
    logger.error('Failed to get credit stats', { error: error.message });
    res.status(500).json({ error: 'Failed to get statistics' });
  }
};

/**
 * Get users with credit balances (admin)
 */
export const getUsersWithCredits = async (req, res) => {
  try {
    const { limit = 100, offset = 0 } = req.query;
    const users = await Credit.getUsersWithCredits(parseInt(limit), parseInt(offset));

    res.json({
      users,
      limit: parseInt(limit),
      offset: parseInt(offset),
    });
  } catch (error) {
    logger.error('Failed to get users with credits', { error: error.message });
    res.status(500).json({ error: 'Failed to get users' });
  }
};

/**
 * Adjust user credit (admin) - Add or deduct credits manually
 */
export const adjustUserCredit = async (req, res) => {
  try {
    const { userId, amount, reason } = req.body;
    const adminId = req.user.id;

    if (!userId || amount === undefined || !reason) {
      return res.status(400).json({ error: 'User ID, amount, and reason are required' });
    }

    // Verify user exists
    const user = await User.getById(userId);
    if (!user) {
      return res.status(404).json({ error: 'User not found' });
    }

    const parsedAmount = parseFloat(amount);
    let result;

    if (parsedAmount > 0) {
      // Adding credits
      result = await Credit.addCredit(
        userId,
        parsedAmount,
        TRANSACTION_TYPES.ADMIN_ADJUSTMENT,
        reason,
        REFERENCE_TYPES.MANUAL,
        `admin_${adminId}`,
        adminId
      );
    } else if (parsedAmount < 0) {
      // Deducting credits
      result = await Credit.deductCredit(
        userId,
        Math.abs(parsedAmount),
        TRANSACTION_TYPES.ADMIN_ADJUSTMENT,
        reason,
        REFERENCE_TYPES.MANUAL,
        `admin_${adminId}`,
        adminId
      );
    } else {
      return res.status(400).json({ error: 'Amount cannot be zero' });
    }

    logger.info('Admin credit adjustment', {
      adminId,
      userId,
      amount: parsedAmount,
      reason,
      newBalance: result.balance_after,
    });

    res.json({
      message: 'Credit adjusted successfully',
      user_id: userId,
      user_email: user.email,
      adjustment: parsedAmount,
      balance_before: result.balance_before,
      balance_after: result.balance_after,
    });
  } catch (error) {
    logger.error('Failed to adjust credit', { error: error.message, adminId: req.user.id });
    res.status(500).json({ error: error.message || 'Failed to adjust credit' });
  }
};

/**
 * Get a specific user's credit details (admin)
 */
export const getUserCreditDetails = async (req, res) => {
  try {
    const { userId } = req.params;

    const user = await User.getById(userId);
    if (!user) {
      return res.status(404).json({ error: 'User not found' });
    }

    const balance = await Credit.getBalance(userId);
    const transactions = await Credit.getTransactionHistory(userId, 20, 0);
    const transactionCount = await Credit.getTransactionCount(userId);

    res.json({
      user: {
        id: user.id,
        name: user.name,
        email: user.email,
        plan_name: user.plan_name,
      },
      balance: parseFloat(balance),
      recent_transactions: transactions,
      total_transactions: transactionCount,
    });
  } catch (error) {
    logger.error('Failed to get user credit details', { error: error.message, userId: req.params.userId });
    res.status(500).json({ error: 'Failed to get user credit details' });
  }
};
