import db from '../config/database.js';

class Invoice {
  static async create(data) {
    const {
      userId,
      stripeInvoiceId,
      stripeSubscriptionId,
      amountTotal,
      currency,
      status,
      invoicePdf,
      hostedInvoiceUrl,
      billingReason,
      paid,
      paidAt,
      dueDate,
    } = data;

    const query = `
      INSERT INTO invoices (
        user_id, stripe_invoice_id, stripe_subscription_id, amount_total,
        currency, status, invoice_pdf, hosted_invoice_url, billing_reason,
        paid, paid_at, due_date
      )
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
      RETURNING *
    `;

    const result = await db.query(query, [
      userId,
      stripeInvoiceId,
      stripeSubscriptionId,
      amountTotal,
      currency,
      status,
      invoicePdf,
      hostedInvoiceUrl,
      billingReason,
      paid,
      paidAt,
      dueDate,
    ]);

    return result.rows[0];
  }

  static async getByUserId(userId, limit = 50) {
    const query = `
      SELECT * FROM invoices
      WHERE user_id = $1
      ORDER BY created_at DESC
      LIMIT $2
    `;
    const result = await db.query(query, [userId, limit]);
    return result.rows;
  }

  static async getByStripeId(stripeInvoiceId) {
    const query = 'SELECT * FROM invoices WHERE stripe_invoice_id = $1';
    const result = await db.query(query, [stripeInvoiceId]);
    return result.rows[0];
  }

  static async getAll(limit = 100, offset = 0) {
    const query = `
      SELECT i.*,
        u.email as user_email,
        u.name as user_name
      FROM invoices i
      LEFT JOIN users u ON i.user_id = u.id
      ORDER BY i.created_at DESC
      LIMIT $1 OFFSET $2
    `;
    const result = await db.query(query, [limit, offset]);
    return result.rows;
  }

  static async update(stripeInvoiceId, data) {
    const fields = [];
    const values = [];
    let paramCount = 1;

    Object.keys(data).forEach((key) => {
      const snakeKey = key.replace(/[A-Z]/g, (letter) => `_${letter.toLowerCase()}`);
      fields.push(`${snakeKey} = $${paramCount}`);
      values.push(data[key]);
      paramCount++;
    });

    if (fields.length === 0) return null;

    const query = `
      UPDATE invoices
      SET ${fields.join(', ')}
      WHERE stripe_invoice_id = $${paramCount}
      RETURNING *
    `;

    values.push(stripeInvoiceId);
    const result = await db.query(query, values);
    return result.rows[0];
  }

  static async getTotalRevenue() {
    const query = `
      SELECT
        SUM(amount_total) as total_revenue,
        COUNT(*) as total_invoices,
        COUNT(CASE WHEN paid = TRUE THEN 1 END) as paid_invoices
      FROM invoices
      WHERE status = 'paid'
    `;
    const result = await db.query(query);
    return result.rows[0];
  }
}

export default Invoice;
