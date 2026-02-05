import db from './database.js';

// Transaction types
export const TRANSACTION_TYPES = {
  PURCHASE: 'purchase',           // User purchased credits via Stripe
  SUBSCRIPTION_CREDIT: 'subscription_credit', // Monthly credit from plan
  PLAN_PAYMENT: 'plan_payment',   // Used credits to pay for plan
  ADMIN_ADJUSTMENT: 'admin_adjustment', // Admin manually adjusted
  REFUND: 'refund',               // Refund issued as credits
  BONUS: 'bonus',                 // Bonus credits (promotions)
  EXPIRED: 'expired',             // Credits expired (if implementing expiry)
};

// Reference types
export const REFERENCE_TYPES = {
  STRIPE_PAYMENT: 'stripe_payment',
  STRIPE_SUBSCRIPTION: 'stripe_subscription',
  INVOICE: 'invoice',
  PLAN: 'plan',
  COUPON: 'coupon',
  MANUAL: 'manual',
};

class Credit {
  /**
   * Get user's current credit balance
   */
  static async getBalance(userId) {
    const stmt = db.prepare('SELECT account_credit FROM users WHERE id = ?');
    const user = await stmt.get(userId);
    return user ? parseFloat(user.account_credit || 0) : 0;
  }

  /**
   * Add credits to user account
   */
  static async addCredit(userId, amount, transactionType, description, referenceType = null, referenceId = null, adminId = null) {
    const currentBalance = await this.getBalance(userId);
    const newBalance = parseFloat(currentBalance) + parseFloat(amount);

    // Record transaction
    await this.recordTransaction({
      user_id: userId,
      transaction_type: transactionType,
      amount: parseFloat(amount),
      balance_before: currentBalance,
      balance_after: newBalance,
      description,
      reference_type: referenceType,
      reference_id: referenceId,
      admin_id: adminId,
    });

    // Update user balance
    const updateStmt = db.prepare('UPDATE users SET account_credit = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?');
    await updateStmt.run(newBalance, userId);

    return {
      balance_before: currentBalance,
      balance_after: newBalance,
      amount_added: parseFloat(amount),
    };
  }

  /**
   * Deduct credits from user account
   */
  static async deductCredit(userId, amount, transactionType, description, referenceType = null, referenceId = null, adminId = null) {
    const currentBalance = await this.getBalance(userId);

    if (currentBalance < amount) {
      throw new Error('Insufficient credit balance');
    }

    const newBalance = parseFloat(currentBalance) - parseFloat(amount);

    // Record transaction (negative amount for deduction)
    await this.recordTransaction({
      user_id: userId,
      transaction_type: transactionType,
      amount: -parseFloat(amount),
      balance_before: currentBalance,
      balance_after: newBalance,
      description,
      reference_type: referenceType,
      reference_id: referenceId,
      admin_id: adminId,
    });

    // Update user balance
    const updateStmt = db.prepare('UPDATE users SET account_credit = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?');
    await updateStmt.run(newBalance, userId);

    return {
      balance_before: currentBalance,
      balance_after: newBalance,
      amount_deducted: parseFloat(amount),
    };
  }

  /**
   * Record a credit transaction
   */
  static async recordTransaction({
    user_id,
    transaction_type,
    amount,
    balance_before,
    balance_after,
    description,
    reference_type,
    reference_id,
    admin_id,
  }) {
    const stmt = db.prepare(`
      INSERT INTO credit_transactions (
        user_id, transaction_type, amount, balance_before, balance_after,
        description, reference_type, reference_id, admin_id
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    const result = await stmt.run(
      user_id,
      transaction_type,
      amount,
      balance_before,
      balance_after,
      description,
      reference_type,
      reference_id,
      admin_id
    );

    return result.lastInsertRowid;
  }

  /**
   * Get transaction history for a user
   */
  static async getTransactionHistory(userId, limit = 50, offset = 0) {
    const stmt = db.prepare(`
      SELECT
        ct.*,
        a.name as admin_name,
        a.email as admin_email
      FROM credit_transactions ct
      LEFT JOIN users a ON ct.admin_id = a.id
      WHERE ct.user_id = ?
      ORDER BY ct.created_at DESC
      LIMIT ? OFFSET ?
    `);
    return await stmt.all(userId, limit, offset);
  }

  /**
   * Get transaction count for pagination
   */
  static async getTransactionCount(userId) {
    const stmt = db.prepare('SELECT COUNT(*) as count FROM credit_transactions WHERE user_id = ?');
    const result = await stmt.get(userId);
    return result.count;
  }

  /**
   * Get all transactions (admin) with user info
   */
  static async getAllTransactions(limit = 100, offset = 0, filters = {}) {
    let whereClause = '1=1';
    const params = [];

    if (filters.userId) {
      whereClause += ' AND ct.user_id = ?';
      params.push(filters.userId);
    }

    if (filters.transactionType) {
      whereClause += ' AND ct.transaction_type = ?';
      params.push(filters.transactionType);
    }

    if (filters.startDate) {
      whereClause += ' AND ct.created_at >= ?';
      params.push(filters.startDate);
    }

    if (filters.endDate) {
      whereClause += ' AND ct.created_at <= ?';
      params.push(filters.endDate);
    }

    const stmt = db.prepare(`
      SELECT
        ct.*,
        u.name as user_name,
        u.email as user_email,
        a.name as admin_name,
        a.email as admin_email
      FROM credit_transactions ct
      JOIN users u ON ct.user_id = u.id
      LEFT JOIN users a ON ct.admin_id = a.id
      WHERE ${whereClause}
      ORDER BY ct.created_at DESC
      LIMIT ? OFFSET ?
    `);

    params.push(limit, offset);
    return await stmt.all(...params);
  }

  /**
   * Get credit statistics (admin)
   */
  static async getStats() {
    const totalCreditsStmt = db.prepare(`
      SELECT COALESCE(SUM(account_credit), 0) as total_credits
      FROM users
    `);
    const totalCredits = await totalCreditsStmt.get();

    const transactionStatsStmt = db.prepare(`
      SELECT
        transaction_type,
        COUNT(*) as count,
        COALESCE(SUM(ABS(amount)), 0) as total_amount
      FROM credit_transactions
      GROUP BY transaction_type
    `);
    const transactionStats = await transactionStatsStmt.all();

    const usersWithCreditsStmt = db.prepare(`
      SELECT COUNT(*) as count
      FROM users
      WHERE account_credit > 0
    `);
    const usersWithCredits = await usersWithCreditsStmt.get();

    const recentTransactionsStmt = db.prepare(`
      SELECT COUNT(*) as count
      FROM credit_transactions
      WHERE created_at >= CURRENT_TIMESTAMP - INTERVAL '30 days'
    `);
    const recentTransactions = await recentTransactionsStmt.get();

    return {
      total_credits_outstanding: parseFloat(totalCredits.total_credits),
      users_with_credits: usersWithCredits.count,
      transactions_last_30_days: recentTransactions.count,
      transaction_breakdown: transactionStats,
    };
  }

  /**
   * Check if user has enough credits for an amount
   */
  static async hasEnoughCredits(userId, amount) {
    const balance = await this.getBalance(userId);
    return balance >= parseFloat(amount);
  }

  /**
   * Get users with credit balances (admin)
   */
  static async getUsersWithCredits(limit = 100, offset = 0) {
    const stmt = db.prepare(`
      SELECT
        u.id, u.name, u.email, u.account_credit,
        p.name as plan_name,
        (
          SELECT COUNT(*)
          FROM credit_transactions
          WHERE user_id = u.id
        ) as transaction_count
      FROM users u
      LEFT JOIN plans p ON u.plan_id = p.id
      WHERE u.account_credit > 0
      ORDER BY u.account_credit DESC
      LIMIT ? OFFSET ?
    `);
    return await stmt.all(limit, offset);
  }

  // =====================
  // Credit Packages
  // =====================

  /**
   * Get all active credit packages
   */
  static async getPackages(includeInactive = false) {
    const condition = includeInactive ? '' : 'WHERE is_active = TRUE';
    const stmt = db.prepare(`
      SELECT * FROM credit_packages
      ${condition}
      ORDER BY sort_order ASC
    `);
    return await stmt.all();
  }

  /**
   * Get credit package by ID
   */
  static async getPackageById(id) {
    const stmt = db.prepare('SELECT * FROM credit_packages WHERE id = ?');
    return await stmt.get(id);
  }

  /**
   * Create credit package (admin)
   */
  static async createPackage({
    name,
    description,
    credit_amount,
    price,
    bonus_credit = 0,
    stripe_price_id = null,
    is_featured = false,
    sort_order = 0,
  }) {
    const stmt = db.prepare(`
      INSERT INTO credit_packages (
        name, description, credit_amount, price, bonus_credit,
        stripe_price_id, is_featured, sort_order
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `);

    const result = await stmt.run(
      name,
      description,
      credit_amount,
      price,
      bonus_credit,
      stripe_price_id,
      is_featured,
      sort_order
    );

    return await this.getPackageById(result.lastInsertRowid);
  }

  /**
   * Update credit package (admin)
   */
  static async updatePackage(id, data) {
    const fields = [];
    const values = [];

    const allowedFields = [
      'name',
      'description',
      'credit_amount',
      'price',
      'bonus_credit',
      'stripe_price_id',
      'is_active',
      'is_featured',
      'sort_order',
    ];

    allowedFields.forEach(field => {
      if (data[field] !== undefined) {
        fields.push(`${field} = ?`);
        values.push(data[field]);
      }
    });

    if (fields.length === 0) return null;

    fields.push('updated_at = CURRENT_TIMESTAMP');
    values.push(id);

    const stmt = db.prepare(`
      UPDATE credit_packages SET ${fields.join(', ')} WHERE id = ?
    `);

    await stmt.run(...values);
    return await this.getPackageById(id);
  }

  /**
   * Delete credit package (admin)
   */
  static async deletePackage(id) {
    const stmt = db.prepare('DELETE FROM credit_packages WHERE id = ?');
    return await stmt.run(id);
  }
}

export default Credit;
