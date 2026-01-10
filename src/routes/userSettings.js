import express from 'express';
import multer from 'multer';
import path from 'path';
import fs from 'fs';
import {
  getUserSettings,
  updateUserSettings,
  resetUserSettings,
} from '../controllers/userSettingsController.js';
import { authenticateToken } from '../middleware/auth.js';
import { checkPlanLimit } from '../middleware/permissions.js';
import UserSettings from '../models/UserSettings.js';
import logger from '../utils/logger.js';

const router = express.Router();

// Ensure uploads directory exists
const uploadsDir = path.join(process.cwd(), 'uploads', 'watermarks', 'users');
if (!fs.existsSync(uploadsDir)) {
  fs.mkdirSync(uploadsDir, { recursive: true });
}

// Configure multer for watermark uploads
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    cb(null, uploadsDir);
  },
  filename: (req, file, cb) => {
    const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1e9);
    cb(null, `user-${req.user.id}-watermark-${uniqueSuffix}${path.extname(file.originalname)}`);
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

// User settings routes - users can view and update their own settings
router.get('/', getUserSettings);
router.put('/', updateUserSettings);
router.post('/reset', resetUserSettings);

// Upload user watermark (requires custom_watermark plan feature)
router.post('/watermark/upload', checkPlanLimit('watermark'), upload.single('watermark'), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: 'No file uploaded' });
    }

    // Delete old watermark if exists
    const oldWatermarkPath = UserSettings.get(req.user.id, 'watermark_path')?.value;
    if (oldWatermarkPath && fs.existsSync(oldWatermarkPath)) {
      try {
        fs.unlinkSync(oldWatermarkPath);
      } catch (error) {
        logger.warn('Failed to delete old user watermark', { userId: req.user.id, error: error.message });
      }
    }

    // Save watermark path to user settings
    UserSettings.set(req.user.id, 'watermark_path', req.file.path);

    logger.info(`User watermark uploaded`, { userId: req.user.id, path: req.file.path });
    res.json({
      message: 'Watermark uploaded successfully',
      path: req.file.path,
      filename: req.file.filename,
    });
  } catch (error) {
    if (req.file) {
      fs.unlinkSync(req.file.path);
    }
    logger.error('Failed to upload user watermark', { userId: req.user.id, error: error.message });
    res.status(500).json({ error: 'Failed to upload watermark' });
  }
});

// Delete user watermark
router.delete('/watermark', async (req, res) => {
  try {
    const watermarkPath = UserSettings.get(req.user.id, 'watermark_path')?.value;

    // Delete watermark file
    if (watermarkPath && fs.existsSync(watermarkPath)) {
      fs.unlinkSync(watermarkPath);
    }

    // Delete from user settings
    UserSettings.delete(req.user.id, 'watermark_path');
    UserSettings.delete(req.user.id, 'watermark_position');
    UserSettings.delete(req.user.id, 'watermark_opacity');
    UserSettings.delete(req.user.id, 'watermark_scale');

    logger.info(`User watermark deleted`, { userId: req.user.id });
    res.json({ message: 'Watermark deleted successfully' });
  } catch (error) {
    logger.error('Failed to delete user watermark', { userId: req.user.id, error: error.message });
    res.status(500).json({ error: 'Failed to delete watermark' });
  }
});

export default router;
