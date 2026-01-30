import SupportTicket from '../models/SupportTicket.js';
import TicketMessage from '../models/TicketMessage.js';
import TicketAttachment from '../models/TicketAttachment.js';
import User from '../models/User.js';
import logger from '../utils/logger.js';
import EmailService from '../services/EmailService.js';
import path from 'path';
import fs from 'fs/promises';

// Create a new support ticket
export const createTicket = async (req, res) => {
  try {
    const { subject, category, channel_id, message, priority } = req.body;
    const user_id = req.user.id;

    // Validation
    if (!subject || !category || !message) {
      return res.status(400).json({ error: 'Subject, category, and message are required' });
    }

    const validCategories = ['technical', 'billing', 'general'];
    if (!validCategories.includes(category)) {
      return res.status(400).json({ error: `Category must be one of: ${validCategories.join(', ')}` });
    }

    // Create ticket with initial message
    const ticket = await SupportTicket.create({
      user_id,
      subject,
      category,
      channel_id: channel_id || null,
      message,
      priority: priority || 'normal'
    });

    // Handle file attachments if present
    if (req.files && req.files.length > 0) {
      const messageId = (await TicketMessage.findByTicketId(ticket.id))[0].id;

      for (const file of req.files) {
        await TicketAttachment.create({
          ticket_id: ticket.id,
          message_id: messageId,
          filename: file.filename,
          original_name: file.originalname,
          file_path: file.path,
          file_size: file.size,
          mime_type: file.mimetype,
          uploaded_by: user_id
        });
      }
    }

    // Get full ticket with messages
    const fullTicket = await SupportTicket.getWithMessages(ticket.id);

    // Send email notifications
    try {
      const user = await User.findById(user_id);
      await EmailService.sendTicketCreatedEmail(user, fullTicket);
      await EmailService.sendTicketCreatedAdminNotification(fullTicket, user);
    } catch (emailError) {
      logger.error('Failed to send ticket creation emails', { error: emailError.message });
    }

    logger.info('Support ticket created', { ticketId: ticket.id, userId: user_id });
    res.status(201).json({ ticket: fullTicket });
  } catch (error) {
    console.error('Error creating support ticket:', error);
    logger.error('Error creating support ticket', { error: error.message, stack: error.stack });
    res.status(500).json({ error: 'Failed to create support ticket' });
  }
};

// Get all tickets (filtered by user if not admin)
export const getTickets = async (req, res) => {
  try {
    const { status, category, page = 1, limit = 50 } = req.query;
    const user_id = req.user.role === 'admin' ? null : req.user.id;

    const tickets = await SupportTicket.findAll({
      status,
      category,
      user_id,
      page: parseInt(page),
      limit: parseInt(limit)
    });

    res.json({ tickets });
  } catch (error) {
    logger.error('Error fetching tickets', { error: error.message });
    res.status(500).json({ error: 'Failed to fetch tickets' });
  }
};

// Get single ticket with messages
export const getTicket = async (req, res) => {
  try {
    const { id } = req.params;
    const ticket = await SupportTicket.getWithMessages(id);

    if (!ticket) {
      return res.status(404).json({ error: 'Ticket not found' });
    }

    // Check permissions: user can only view their own tickets, admin can view all
    if (req.user.role !== 'admin' && ticket.user_id !== req.user.id) {
      return res.status(403).json({ error: 'Access denied' });
    }

    res.json({ ticket });
  } catch (error) {
    logger.error('Error fetching ticket', { error: error.message });
    res.status(500).json({ error: 'Failed to fetch ticket' });
  }
};

// Add reply to ticket
export const addReply = async (req, res) => {
  try {
    const { id } = req.params;
    const { message, is_internal_note = false } = req.body;
    const user_id = req.user.id;

    if (!message) {
      return res.status(400).json({ error: 'Message is required' });
    }

    // Get ticket
    const ticket = await SupportTicket.findById(id);
    if (!ticket) {
      return res.status(404).json({ error: 'Ticket not found' });
    }

    // Check permissions
    if (req.user.role !== 'admin' && ticket.user_id !== req.user.id) {
      return res.status(403).json({ error: 'Access denied' });
    }

    // Internal notes can only be created by admins
    if (is_internal_note && req.user.role !== 'admin') {
      return res.status(403).json({ error: 'Only admins can create internal notes' });
    }

    // Create message
    const messageRecord = await TicketMessage.create({
      ticket_id: id,
      user_id,
      message,
      is_internal_note
    });

    // Handle file attachments if present
    if (req.files && req.files.length > 0) {
      for (const file of req.files) {
        await TicketAttachment.create({
          ticket_id: id,
          message_id: messageRecord.id,
          filename: file.filename,
          original_name: file.originalname,
          file_path: file.path,
          file_size: file.size,
          mime_type: file.mimetype,
          uploaded_by: user_id
        });
      }
    }

    // Get full ticket with updated messages
    const fullTicket = await SupportTicket.getWithMessages(id);

    // Send email notification (not for internal notes)
    if (!is_internal_note) {
      try {
        const user = await User.findById(user_id);
        const isAdminReply = req.user.role === 'admin';
        await EmailService.sendTicketReplyEmail(fullTicket, user, message, isAdminReply);
      } catch (emailError) {
        logger.error('Failed to send reply email', { error: emailError.message });
      }
    }

    logger.info('Reply added to ticket', { ticketId: id, userId: user_id });
    res.status(201).json({ ticket: fullTicket });
  } catch (error) {
    logger.error('Error adding reply', { error: error.message });
    res.status(500).json({ error: 'Failed to add reply' });
  }
};

// Update ticket status (admin only)
export const updateTicketStatus = async (req, res) => {
  try {
    const { id } = req.params;
    const { status } = req.body;

    if (!status) {
      return res.status(400).json({ error: 'Status is required' });
    }

    const oldTicket = await SupportTicket.findById(id);
    if (!oldTicket) {
      return res.status(404).json({ error: 'Ticket not found' });
    }

    const oldStatus = oldTicket.status;
    const ticket = await SupportTicket.updateStatus(id, status, req.user.id);

    // Send email notification
    try {
      const user = await User.findById(ticket.user_id);
      await EmailService.sendTicketStatusChangedEmail(ticket, user, oldStatus, status);
    } catch (emailError) {
      logger.error('Failed to send status change email', { error: emailError.message });
    }

    logger.info('Ticket status updated', { ticketId: id, oldStatus, newStatus: status });
    res.json({ ticket });
  } catch (error) {
    logger.error('Error updating ticket status', { error: error.message });
    res.status(500).json({ error: error.message || 'Failed to update ticket status' });
  }
};

// Assign ticket to admin (admin only)
export const assignTicket = async (req, res) => {
  try {
    const { id } = req.params;
    const { admin_id } = req.body;

    if (!admin_id) {
      return res.status(400).json({ error: 'Admin ID is required' });
    }

    // Verify admin exists and has admin role
    const admin = await User.findById(admin_id);
    if (!admin || admin.role !== 'admin') {
      return res.status(400).json({ error: 'Invalid admin user' });
    }

    const ticket = await SupportTicket.assignTo(id, admin_id);

    logger.info('Ticket assigned', { ticketId: id, assignedTo: admin_id });
    res.json({ ticket });
  } catch (error) {
    logger.error('Error assigning ticket', { error: error.message });
    res.status(500).json({ error: 'Failed to assign ticket' });
  }
};

// Close ticket
export const closeTicket = async (req, res) => {
  try {
    const { id } = req.params;
    const ticket = await SupportTicket.findById(id);

    if (!ticket) {
      return res.status(404).json({ error: 'Ticket not found' });
    }

    // Check permissions: user can close their own ticket, admin can close any
    if (req.user.role !== 'admin' && ticket.user_id !== req.user.id) {
      return res.status(403).json({ error: 'Access denied' });
    }

    const closedTicket = await SupportTicket.close(id, req.user.id);

    // Send email notification
    try {
      const user = await User.findById(ticket.user_id);
      await EmailService.sendTicketClosedEmail(closedTicket, user);
    } catch (emailError) {
      logger.error('Failed to send ticket closed email', { error: emailError.message });
    }

    logger.info('Ticket closed', { ticketId: id, closedBy: req.user.id });
    res.json({ ticket: closedTicket });
  } catch (error) {
    logger.error('Error closing ticket', { error: error.message });
    res.status(500).json({ error: 'Failed to close ticket' });
  }
};

// Get ticket statistics
export const getTicketStats = async (req, res) => {
  try {
    const user_id = req.user.role === 'admin' ? null : req.user.id;
    const stats = await SupportTicket.getStats({ user_id });

    res.json({ stats });
  } catch (error) {
    logger.error('Error fetching ticket stats', { error: error.message });
    res.status(500).json({ error: 'Failed to fetch ticket statistics' });
  }
};

// Delete ticket (admin only)
export const deleteTicket = async (req, res) => {
  try {
    const { id } = req.params;

    // Get ticket to delete its attachments
    const ticket = await SupportTicket.getWithMessages(id);
    if (!ticket) {
      return res.status(404).json({ error: 'Ticket not found' });
    }

    // Delete all attachment files
    const attachments = await TicketAttachment.findByTicketId(id);
    for (const attachment of attachments) {
      try {
        await fs.unlink(attachment.file_path);
      } catch (error) {
        logger.warn('Failed to delete attachment file', { path: attachment.file_path });
      }
    }

    // Delete ticket (will cascade to messages and attachments in DB)
    await SupportTicket.delete(id);

    logger.info('Ticket deleted', { ticketId: id, deletedBy: req.user.id });
    res.json({ message: 'Ticket deleted successfully' });
  } catch (error) {
    logger.error('Error deleting ticket', { error: error.message });
    res.status(500).json({ error: 'Failed to delete ticket' });
  }
};

// Download attachment
export const downloadAttachment = async (req, res) => {
  try {
    const { id } = req.params;
    const attachment = await TicketAttachment.findById(id);

    if (!attachment) {
      return res.status(404).json({ error: 'Attachment not found' });
    }

    // Get ticket to check permissions
    const ticket = await SupportTicket.findById(attachment.ticket_id);
    if (!ticket) {
      return res.status(404).json({ error: 'Ticket not found' });
    }

    // Check permissions
    if (req.user.role !== 'admin' && ticket.user_id !== req.user.id) {
      return res.status(403).json({ error: 'Access denied' });
    }

    // Check if file is an image to display inline
    const imageExtensions = ['jpg', 'jpeg', 'png', 'gif', 'webp', 'bmp'];
    const ext = path.extname(attachment.original_name).toLowerCase().slice(1);
    const isImage = imageExtensions.includes(ext);

    // Set appropriate content type
    if (attachment.mime_type) {
      res.setHeader('Content-Type', attachment.mime_type);
    }

    // For images, set content-disposition to inline so they display in browser
    if (isImage) {
      res.setHeader('Content-Disposition', `inline; filename="${attachment.original_name}"`);
      res.sendFile(path.resolve(attachment.file_path));
    } else {
      // For other files, force download
      res.download(attachment.file_path, attachment.original_name);
    }
  } catch (error) {
    logger.error('Error downloading attachment', { error: error.message });
    res.status(500).json({ error: 'Failed to download attachment' });
  }
};
