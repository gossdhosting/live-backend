import db from './database.js';
import fs from 'fs/promises';
import path from 'path';

class TicketAttachment {
  // Create a new attachment record
  static async create({
    ticket_id,
    message_id,
    filename,
    original_name,
    file_path,
    file_size,
    mime_type,
    uploaded_by
  }) {
    const stmt = db.prepare(`
      INSERT INTO ticket_attachments (
        ticket_id, message_id, filename, original_name,
        file_path, file_size, mime_type, uploaded_by
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `);

    const result = await stmt.run(
      ticket_id,
      message_id,
      filename,
      original_name,
      file_path,
      file_size,
      mime_type,
      uploaded_by
    );

    return await this.findById(result.lastInsertRowid);
  }

  // Find attachment by ID
  static async findById(id) {
    const stmt = db.prepare(`
      SELECT
        ta.*,
        u.email as uploader_email,
        u.name as uploader_name
      FROM ticket_attachments ta
      LEFT JOIN users u ON ta.uploaded_by = u.id
      WHERE ta.id = ?
    `);
    return await stmt.get(id);
  }

  // Find all attachments for a ticket
  static async findByTicketId(ticket_id) {
    const stmt = db.prepare(`
      SELECT
        ta.*,
        u.email as uploader_email,
        u.name as uploader_name
      FROM ticket_attachments ta
      LEFT JOIN users u ON ta.uploaded_by = u.id
      WHERE ta.ticket_id = ?
      ORDER BY ta.created_at DESC
    `);
    return await stmt.all(ticket_id);
  }

  // Find all attachments for a specific message
  static async findByMessageId(message_id) {
    const stmt = db.prepare(`
      SELECT
        ta.*,
        u.email as uploader_email,
        u.name as uploader_name
      FROM ticket_attachments ta
      LEFT JOIN users u ON ta.uploaded_by = u.id
      WHERE ta.message_id = ?
      ORDER BY ta.created_at ASC
    `);
    return await stmt.all(message_id);
  }

  // Delete attachment and file
  static async delete(id) {
    const attachment = await this.findById(id);
    if (!attachment) {
      throw new Error('Attachment not found');
    }

    // Delete file from filesystem
    try {
      await fs.unlink(attachment.file_path);
    } catch (error) {
      console.error('Failed to delete attachment file:', error);
      // Continue with database deletion even if file deletion fails
    }

    // Delete database record
    const stmt = db.prepare('DELETE FROM ticket_attachments WHERE id = ?');
    return await stmt.run(id);
  }

  // Get total size of attachments for a ticket
  static async getTotalSizeByTicketId(ticket_id) {
    const stmt = db.prepare(`
      SELECT COALESCE(SUM(file_size), 0) as total_size
      FROM ticket_attachments
      WHERE ticket_id = ?
    `);
    const result = await stmt.get(ticket_id);
    return result.total_size;
  }

  // Get attachment count for a ticket
  static async getCountByTicketId(ticket_id) {
    const stmt = db.prepare(`
      SELECT COUNT(*) as count
      FROM ticket_attachments
      WHERE ticket_id = ?
    `);
    const result = await stmt.get(ticket_id);
    return result.count;
  }

  // Bulk create attachments (for multiple files)
  static async createBulk(attachments) {
    const results = [];
    for (const attachment of attachments) {
      const result = await this.create(attachment);
      results.push(result);
    }
    return results;
  }
}

export default TicketAttachment;
