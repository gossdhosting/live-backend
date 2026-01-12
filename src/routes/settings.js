import express from 'express';
import multer from 'multer';
import path from 'path';
import fs from 'fs';
import nodemailer from 'nodemailer';
import {
  getAllSettings,
  updateSettings,
  testPushover,
} from '../controllers/settingsController.js';
import { authenticateToken, requireAdmin } from '../middleware/auth.js';
import Settings from '../models/Settings.js';
import logger from '../utils/logger.js';

const router = express.Router();

// Ensure uploads directory exists
const uploadsDir = path.join(process.cwd(), 'uploads', 'system');
if (!fs.existsSync(uploadsDir)) {
  fs.mkdirSync(uploadsDir, { recursive: true });
}

// Configure multer for default watermark upload
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    cb(null, uploadsDir);
  },
  filename: (req, file, cb) => {
    cb(null, 'default-watermark' + path.extname(file.originalname));
  },
});

const upload = multer({
  storage,
  limits: {
    fileSize: 5 * 1024 * 1024, // 5MB limit
  },
  fileFilter: (req, file, cb) => {
    const allowedTypes = /jpeg|jpg|png|gif/;
    const extname = allowedTypes.test(path.extname(file.originalname).toLowerCase());
    const mimetype = allowedTypes.test(file.mimetype);

    if (mimetype && extname) {
      return cb(null, true);
    } else {
      cb(new Error('Only image files are allowed (jpeg, jpg, png, gif)'));
    }
  },
});

// All routes require authentication
router.use(authenticateToken);

// Settings routes - users can view, only admins can update
router.get('/', getAllSettings);
router.put('/', requireAdmin, updateSettings);

// Upload default watermark (admin only)
router.post('/default-watermark', requireAdmin, upload.single('watermark'), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: 'No file uploaded' });
    }

    // Delete old default watermark if exists
    const oldRelativePath = Settings.get('default_watermark_path')?.value;
    if (oldRelativePath) {
      // Convert relative path to absolute for deletion
      const oldAbsolutePath = oldRelativePath.startsWith('/')
        ? oldRelativePath
        : path.join(process.cwd(), oldRelativePath);

      if (fs.existsSync(oldAbsolutePath) && oldAbsolutePath !== req.file.path) {
        try {
          fs.unlinkSync(oldAbsolutePath);
        } catch (error) {
          logger.warn('Failed to delete old default watermark', { error: error.message });
        }
      }
    }

    // Save relative path for frontend to use (e.g., "uploads/system/default-watermark.png")
    const relativePath = path.relative(process.cwd(), req.file.path).replace(/\\/g, '/');
    Settings.set('default_watermark_path', relativePath);

    logger.info('Default watermark uploaded', { path: relativePath, absolutePath: req.file.path });
    res.json({
      message: 'Default watermark uploaded successfully',
      path: relativePath,
      filename: req.file.filename,
    });
  } catch (error) {
    if (req.file) {
      fs.unlinkSync(req.file.path);
    }
    logger.error('Failed to upload default watermark', { error: error.message });
    res.status(500).json({ error: 'Failed to upload default watermark' });
  }
});

// Delete default watermark (admin only)
router.delete('/default-watermark', requireAdmin, async (req, res) => {
  try {
    const watermarkPath = Settings.get('default_watermark_path')?.value;

    if (watermarkPath) {
      // Convert relative path to absolute for deletion
      const absolutePath = watermarkPath.startsWith('/')
        ? watermarkPath
        : path.join(process.cwd(), watermarkPath);

      if (fs.existsSync(absolutePath)) {
        fs.unlinkSync(absolutePath);
      }
    }

    Settings.set('default_watermark_path', '');

    logger.info('Default watermark deleted');
    res.json({ message: 'Default watermark deleted successfully' });
  } catch (error) {
    logger.error('Failed to delete default watermark', { error: error.message });
    res.status(500).json({ error: 'Failed to delete default watermark' });
  }
});

// Test SMTP settings (admin only)
router.post('/test-smtp', requireAdmin, async (req, res) => {
  try {
    const { testEmail } = req.body;

    if (!testEmail) {
      return res.status(400).json({ error: 'Test email address is required' });
    }

    // Get SMTP settings from database
    const smtpHost = Settings.get('smtp_host')?.value;
    const smtpPort = Settings.get('smtp_port')?.value;
    const smtpSecure = Settings.get('smtp_secure')?.value === '1';
    const smtpUser = Settings.get('smtp_user')?.value;
    const smtpPassword = Settings.get('smtp_password')?.value;
    const smtpFromEmail = Settings.get('smtp_from_email')?.value;
    const smtpFromName = Settings.get('smtp_from_name')?.value;

    if (!smtpHost || !smtpPort || !smtpUser || !smtpPassword || !smtpFromEmail) {
      return res.status(400).json({ error: 'SMTP settings are incomplete. Please fill in all required fields.' });
    }

    // Create transporter
    const transporter = nodemailer.createTransport({
      host: smtpHost,
      port: parseInt(smtpPort),
      secure: smtpSecure,
      auth: {
        user: smtpUser,
        pass: smtpPassword,
      },
    });

    // Verify connection
    await transporter.verify();

    // Send test email
    const info = await transporter.sendMail({
      from: `"${smtpFromName || 'RexStream'}" <${smtpFromEmail}>`,
      to: testEmail,
      subject: 'SMTP Test Email - RexStream',
      text: 'This is a test email from RexStream to verify your SMTP settings are working correctly.',
      html: `
        <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
          <h2 style="color: #3498db;">SMTP Test Successful</h2>
          <p>This is a test email from <strong>RexStream</strong> to verify your SMTP settings are working correctly.</p>
          <p style="color: #7f8c8d; font-size: 12px; margin-top: 30px;">
            If you received this email, your SMTP configuration is properly set up.
          </p>
        </div>
      `,
    });

    logger.info('SMTP test email sent successfully', {
      messageId: info.messageId,
      recipient: testEmail,
      smtpHost,
      smtpPort
    });

    res.json({
      success: true,
      message: `Test email sent successfully to ${testEmail}. Please check your inbox.`,
      messageId: info.messageId
    });
  } catch (error) {
    logger.error('SMTP test failed', { error: error.message, stack: error.stack });

    let errorMessage = 'Failed to send test email. ';
    if (error.code === 'EAUTH') {
      errorMessage += 'Authentication failed. Please check your username and password.';
    } else if (error.code === 'ECONNECTION' || error.code === 'ETIMEDOUT') {
      errorMessage += 'Could not connect to SMTP server. Please check host and port.';
    } else if (error.code === 'ESOCKET') {
      errorMessage += 'Socket error. Please verify your SMTP settings.';
    } else {
      errorMessage += error.message;
    }

    res.status(500).json({ error: errorMessage });
  }
});

// Test Pushover notification (admin only)
router.post('/test-pushover', requireAdmin, testPushover);

export default router;
