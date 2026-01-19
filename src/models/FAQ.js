import db from './database.js';

class FAQ {
  // Get all FAQs (for admin)
  static async getAll() {
    const sql = `
      SELECT * FROM faqs
      ORDER BY display_order ASC, created_at DESC
    `;
    return db.prepare(sql).all();
  }

  // Get active FAQs (for users)
  static async getActive() {
    const sql = `
      SELECT id, question, answer, category, display_order
      FROM faqs
      WHERE is_active = true
      ORDER BY display_order ASC, created_at DESC
    `;
    return db.prepare(sql).all();
  }

  // Get FAQ by ID
  static async getById(id) {
    const sql = 'SELECT * FROM faqs WHERE id = ?';
    return db.prepare(sql).get(id);
  }

  // Create FAQ
  static async create({ question, answer, category = null, display_order = 0, is_active = true }) {
    const sql = `
      INSERT INTO faqs (question, answer, category, display_order, is_active)
      VALUES (?, ?, ?, ?, ?)
      RETURNING *
    `;
    return db.prepare(sql).get(question, answer, category, display_order, is_active);
  }

  // Update FAQ
  static async update(id, { question, answer, category, display_order, is_active }) {
    const sql = `
      UPDATE faqs
      SET question = ?,
          answer = ?,
          category = ?,
          display_order = ?,
          is_active = ?,
          updated_at = CURRENT_TIMESTAMP
      WHERE id = ?
      RETURNING *
    `;
    return db.prepare(sql).get(question, answer, category, display_order, is_active, id);
  }

  // Delete FAQ
  static async delete(id) {
    const sql = 'DELETE FROM faqs WHERE id = ?';
    return db.prepare(sql).run(id);
  }

  // Reorder FAQs
  static async updateOrder(faqOrders) {
    // faqOrders is an array of {id, display_order}
    for (const { id, display_order } of faqOrders) {
      const sql = 'UPDATE faqs SET display_order = ? WHERE id = ?';
      await db.prepare(sql).run(display_order, id);
    }
    return true;
  }
}

export default FAQ;
