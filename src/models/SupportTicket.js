import db from './database.js';

class SupportTicket {
  // Generate unique ticket number in format: TICKET-YYYYMMDD-XXXXX
  static generateTicketNumber() {
    const now = new Date();
    const dateStr = now.toISOString().slice(0, 10).replace(/-/g, '');
    const random = Math.floor(Math.random() * 100000).toString().padStart(5, '0');
    return `TICKET-${dateStr}-${random}`;
  }

  // Create a new support ticket with initial message
  static async create({ user_id, subject, category, channel_id = null, message, priority = 'normal' }) {
    let ticketNumber;
    let attempts = 0;
    const maxAttempts = 5;

    // Generate unique ticket number with retry logic
    while (attempts < maxAttempts) {
      ticketNumber = this.generateTicketNumber();
      const existing = await db.prepare('SELECT id FROM support_tickets WHERE ticket_number = ?').get(ticketNumber);
      if (!existing) break;
      attempts++;
    }

    if (attempts === maxAttempts) {
      throw new Error('Failed to generate unique ticket number');
    }

    const stmt = db.prepare(`
      INSERT INTO support_tickets (
        user_id, ticket_number, subject, category, channel_id, priority, status
      )
      VALUES (?, ?, ?, ?, ?, ?, 'open')
    `);

    const result = await stmt.run(user_id, ticketNumber, subject, category, channel_id, priority);
    const ticketId = result.lastInsertRowid;

    // Add initial message
    const messageStmt = db.prepare(`
      INSERT INTO ticket_messages (ticket_id, user_id, message)
      VALUES (?, ?, ?)
    `);
    await messageStmt.run(ticketId, user_id, message);

    return await this.findById(ticketId);
  }

  // Find ticket by ID with user details
  static async findById(id) {
    const stmt = db.prepare(`
      SELECT
        st.*,
        u.email as user_email,
        u.name as user_name,
        c.name as channel_name,
        au.email as assigned_admin_email,
        au.name as assigned_admin_name
      FROM support_tickets st
      LEFT JOIN users u ON st.user_id = u.id
      LEFT JOIN channels c ON st.channel_id = c.id
      LEFT JOIN users au ON st.assigned_to = au.id
      WHERE st.id = ?
    `);
    return await stmt.get(id);
  }

  // Find all tickets with filters
  static async findAll({ status = null, category = null, user_id = null, assigned_to = null, page = 1, limit = 50 } = {}) {
    let conditions = [];
    let params = [];

    if (status) {
      conditions.push('st.status = ?');
      params.push(status);
    }

    if (category) {
      conditions.push('st.category = ?');
      params.push(category);
    }

    if (user_id) {
      conditions.push('st.user_id = ?');
      params.push(user_id);
    }

    if (assigned_to) {
      conditions.push('st.assigned_to = ?');
      params.push(assigned_to);
    }

    const whereClause = conditions.length > 0 ? 'WHERE ' + conditions.join(' AND ') : '';
    const offset = (page - 1) * limit;

    const stmt = db.prepare(`
      SELECT
        st.*,
        u.email as user_email,
        u.name as user_name,
        c.name as channel_name,
        au.email as assigned_admin_email,
        au.name as assigned_admin_name
      FROM support_tickets st
      LEFT JOIN users u ON st.user_id = u.id
      LEFT JOIN channels c ON st.channel_id = c.id
      LEFT JOIN users au ON st.assigned_to = au.id
      ${whereClause}
      ORDER BY st.created_at DESC
      LIMIT ? OFFSET ?
    `);

    return await stmt.all(...params, limit, offset);
  }

  // Get ticket with all messages and attachments
  static async getWithMessages(id) {
    const ticket = await this.findById(id);
    if (!ticket) return null;

    // Get all messages
    const messagesStmt = db.prepare(`
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
    const messages = await messagesStmt.all(id);

    // Get attachments for each message
    for (let message of messages) {
      const attachmentsStmt = db.prepare(`
        SELECT * FROM ticket_attachments
        WHERE message_id = ?
        ORDER BY created_at ASC
      `);
      message.attachments = await attachmentsStmt.all(message.id);
    }

    ticket.messages = messages;
    return ticket;
  }

  // Update ticket status
  static async updateStatus(id, status, admin_id = null) {
    const validStatuses = ['open', 'in_progress', 'waiting_customer', 'resolved', 'closed'];
    if (!validStatuses.includes(status)) {
      throw new Error(`Invalid status. Must be one of: ${validStatuses.join(', ')}`);
    }

    const stmt = db.prepare(`
      UPDATE support_tickets
      SET status = ?, updated_at = CURRENT_TIMESTAMP
      WHERE id = ?
    `);

    await stmt.run(status, id);
    return await this.findById(id);
  }

  // Assign ticket to admin
  static async assignTo(id, admin_id) {
    const stmt = db.prepare(`
      UPDATE support_tickets
      SET assigned_to = ?, updated_at = CURRENT_TIMESTAMP
      WHERE id = ?
    `);

    await stmt.run(admin_id, id);
    return await this.findById(id);
  }

  // Close ticket
  static async close(id, admin_id = null) {
    const stmt = db.prepare(`
      UPDATE support_tickets
      SET status = 'closed', closed_at = CURRENT_TIMESTAMP, closed_by = ?, updated_at = CURRENT_TIMESTAMP
      WHERE id = ?
    `);

    await stmt.run(admin_id, id);
    return await this.findById(id);
  }

  // Update priority
  static async updatePriority(id, priority) {
    const validPriorities = ['low', 'normal', 'high', 'urgent'];
    if (!validPriorities.includes(priority)) {
      throw new Error(`Invalid priority. Must be one of: ${validPriorities.join(', ')}`);
    }

    const stmt = db.prepare(`
      UPDATE support_tickets
      SET priority = ?, updated_at = CURRENT_TIMESTAMP
      WHERE id = ?
    `);

    await stmt.run(priority, id);
    return await this.findById(id);
  }

  // Get ticket statistics
  static async getStats({ user_id = null } = {}) {
    const userFilter = user_id ? 'WHERE user_id = ?' : '';
    const params = user_id ? [user_id] : [];

    const stmt = db.prepare(`
      SELECT
        COUNT(*) as total,
        SUM(CASE WHEN status = 'open' THEN 1 ELSE 0 END) as open,
        SUM(CASE WHEN status = 'in_progress' THEN 1 ELSE 0 END) as in_progress,
        SUM(CASE WHEN status = 'waiting_customer' THEN 1 ELSE 0 END) as waiting_customer,
        SUM(CASE WHEN status = 'resolved' THEN 1 ELSE 0 END) as resolved,
        SUM(CASE WHEN status = 'closed' THEN 1 ELSE 0 END) as closed
      FROM support_tickets
      ${userFilter}
    `);

    return await stmt.get(...params);
  }

  // Delete ticket (admin only)
  static async delete(id) {
    // This will cascade delete messages and attachments
    const stmt = db.prepare('DELETE FROM support_tickets WHERE id = ?');
    return await stmt.run(id);
  }

  // Get recent tickets for dashboard
  static async getRecent(limit = 5, user_id = null) {
    const userFilter = user_id ? 'WHERE st.user_id = ?' : '';
    const params = user_id ? [user_id, limit] : [limit];

    const stmt = db.prepare(`
      SELECT
        st.*,
        u.email as user_email,
        u.name as user_name,
        c.name as channel_name
      FROM support_tickets st
      LEFT JOIN users u ON st.user_id = u.id
      LEFT JOIN channels c ON st.channel_id = c.id
      ${userFilter}
      ORDER BY st.created_at DESC
      LIMIT ?
    `);

    if (user_id) {
      return await stmt.all(user_id, limit);
    }
    return await stmt.all(limit);
  }
}

export default SupportTicket;
