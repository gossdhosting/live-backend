import db from './database.js';

class TicketMessage {
  // Create a new ticket message/reply
  static async create({ ticket_id, user_id, message, is_internal_note = false }) {
    const stmt = db.prepare(`
      INSERT INTO ticket_messages (ticket_id, user_id, message, is_internal_note)
      VALUES (?, ?, ?, ?)
    `);

    const result = await stmt.run(ticket_id, user_id, message, is_internal_note);

    // Update ticket's updated_at timestamp
    const updateTicketStmt = db.prepare(`
      UPDATE support_tickets
      SET updated_at = CURRENT_TIMESTAMP
      WHERE id = ?
    `);
    await updateTicketStmt.run(ticket_id);

    return await this.findById(result.lastInsertRowid);
  }

  // Find message by ID
  static async findById(id) {
    const stmt = db.prepare(`
      SELECT
        tm.*,
        u.email as user_email,
        u.name as user_name,
        u.role as user_role
      FROM ticket_messages tm
      LEFT JOIN users u ON tm.user_id = u.id
      WHERE tm.id = ?
    `);
    return await stmt.get(id);
  }

  // Find all messages for a ticket
  static async findByTicketId(ticket_id) {
    const stmt = db.prepare(`
      SELECT
        tm.*,
        u.email as user_email,
        u.name as user_name,
        u.role as user_role
      FROM ticket_messages tm
      LEFT JOIN users u ON tm.user_id = u.id
      WHERE tm.ticket_id = ?
      ORDER BY tm.created_at ASC
    `);
    return await stmt.all(ticket_id);
  }

  // Get message count for a ticket
  static async getCountByTicketId(ticket_id) {
    const stmt = db.prepare(`
      SELECT COUNT(*) as count
      FROM ticket_messages
      WHERE ticket_id = ?
    `);
    const result = await stmt.get(ticket_id);
    return result.count;
  }

  // Delete a message (admin only)
  static async delete(id) {
    const stmt = db.prepare('DELETE FROM ticket_messages WHERE id = ?');
    return await stmt.run(id);
  }

  // Update message content (for editing within short time window)
  static async update(id, message) {
    const stmt = db.prepare(`
      UPDATE ticket_messages
      SET message = ?
      WHERE id = ?
    `);
    await stmt.run(message, id);
    return await this.findById(id);
  }
}

export default TicketMessage;
