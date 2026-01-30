import express from 'express';
import multer from 'multer';
import path from 'path';
import fs from 'fs';
import { authenticateToken, requireAdmin } from '../middleware/auth.js';
import * as ticketController from '../controllers/ticketController.js';

const router = express.Router();

// Create uploads directory if it doesn't exist
const uploadsDir = 'uploads/tickets';
if (!fs.existsSync(uploadsDir)) {
  fs.mkdirSync(uploadsDir, { recursive: true });
}

// Configure multer for ticket attachments
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    cb(null, uploadsDir);
  },
  filename: (req, file, cb) => {
    const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
    const ext = path.extname(file.originalname);
    cb(null, `ticket-${uniqueSuffix}${ext}`);
  }
});

const upload = multer({
  storage,
  limits: {
    fileSize: 10 * 1024 * 1024, // 10MB per file
    files: 5 // Maximum 5 files
  },
  fileFilter: (req, file, cb) => {
    // Allow common file types
    const allowedTypes = /jpeg|jpg|png|gif|pdf|txt|doc|docx|xls|xlsx|zip|mp4|mov|avi/;
    const extname = allowedTypes.test(path.extname(file.originalname).toLowerCase());
    const mimetype = allowedTypes.test(file.mimetype);

    if (extname && mimetype) {
      return cb(null, true);
    } else {
      cb(new Error('Invalid file type. Allowed types: images, PDFs, documents, spreadsheets, ZIP archives, and videos.'));
    }
  }
});

// User routes (authenticated)
router.post('/', authenticateToken, upload.array('attachments', 5), ticketController.createTicket);
router.get('/', authenticateToken, ticketController.getTickets);
router.get('/stats', authenticateToken, ticketController.getTicketStats);
router.get('/:id', authenticateToken, ticketController.getTicket);
router.post('/:id/reply', authenticateToken, upload.array('attachments', 5), ticketController.addReply);
router.post('/:id/close', authenticateToken, ticketController.closeTicket);
router.get('/attachments/:id/download', authenticateToken, ticketController.downloadAttachment);

// Admin routes
router.put('/:id/status', authenticateToken, requireAdmin, ticketController.updateTicketStatus);
router.put('/:id/assign', authenticateToken, requireAdmin, ticketController.assignTicket);
router.delete('/:id', authenticateToken, requireAdmin, ticketController.deleteTicket);

export default router;
