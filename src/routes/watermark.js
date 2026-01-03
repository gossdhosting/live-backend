import express from 'express';
import multer from 'multer';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';
import Channel from '../models/Channel.js';
import { authenticateToken, requireAdmin } from '../middleware/auth.js';
import logger from '../utils/logger.js';

const router = express.Router();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Ensure uploads directory exists
const uploadsDir = path.join(process.cwd(), 'uploads', 'watermarks');
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
    cb(null, 'watermark-' + uniqueSuffix + path.extname(file.originalname));
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
router.use(requireAdmin);

// Upload watermark
router.post('/upload/:channelId', upload.single('watermark'), async (req, res) => {
  try {
    const { channelId } = req.params;

    // Verify channel exists
    const channel = Channel.findById(channelId);
    if (!channel) {
      if (req.file) {
        fs.unlinkSync(req.file.path);
      }
      return res.status(404).json({ error: 'Channel not found' });
    }

    // Check if stream is running
    if (channel.status === 'running') {
      if (req.file) {
        fs.unlinkSync(req.file.path);
      }
      return res.status(400).json({ error: 'Cannot update watermark while stream is running. Please stop the stream first.' });
    }

    if (!req.file) {
      return res.status(400).json({ error: 'No file uploaded' });
    }

    // Delete old watermark if exists
    if (channel.watermark_path && fs.existsSync(channel.watermark_path)) {
      try {
        fs.unlinkSync(channel.watermark_path);
      } catch (error) {
        logger.warn('Failed to delete old watermark', { error: error.message });
      }
    }

    logger.info(`Watermark uploaded for channel ${channelId}`, { path: req.file.path });
    res.json({
      message: 'Watermark uploaded successfully',
      path: req.file.path,
      filename: req.file.filename,
    });
  } catch (error) {
    if (req.file) {
      fs.unlinkSync(req.file.path);
    }
    logger.error('Failed to upload watermark', { error: error.message });
    res.status(500).json({ error: 'Failed to upload watermark' });
  }
});

// Update watermark settings
router.put('/:channelId', async (req, res) => {
  try {
    const { channelId } = req.params;
    const { watermark_enabled, watermark_path, watermark_position, watermark_opacity } = req.body;

    // Verify channel exists
    const channel = Channel.findById(channelId);
    if (!channel) {
      return res.status(404).json({ error: 'Channel not found' });
    }

    // Check if stream is running
    if (channel.status === 'running') {
      return res.status(400).json({ error: 'Cannot update watermark settings while stream is running. Please stop the stream first.' });
    }

    const updateData = {};
    if (watermark_enabled !== undefined) updateData.watermark_enabled = watermark_enabled ? 1 : 0;
    if (watermark_path !== undefined) updateData.watermark_path = watermark_path;
    if (watermark_position !== undefined) updateData.watermark_position = watermark_position;
    if (watermark_opacity !== undefined) updateData.watermark_opacity = watermark_opacity;

    const updated = Channel.update(channelId, updateData);
    logger.info(`Watermark settings updated for channel ${channelId}`, updateData);

    res.json({
      message: 'Watermark settings updated successfully',
      channel: updated,
    });
  } catch (error) {
    logger.error('Failed to update watermark settings', { error: error.message });
    res.status(500).json({ error: 'Failed to update watermark settings' });
  }
});

// Delete watermark
router.delete('/:channelId', async (req, res) => {
  try {
    const { channelId } = req.params;

    // Verify channel exists
    const channel = Channel.findById(channelId);
    if (!channel) {
      return res.status(404).json({ error: 'Channel not found' });
    }

    // Check if stream is running
    if (channel.status === 'running') {
      return res.status(400).json({ error: 'Cannot delete watermark while stream is running. Please stop the stream first.' });
    }

    // Delete watermark file
    if (channel.watermark_path && fs.existsSync(channel.watermark_path)) {
      fs.unlinkSync(channel.watermark_path);
    }

    // Update channel settings
    Channel.update(channelId, {
      watermark_enabled: 0,
      watermark_path: null,
    });

    logger.info(`Watermark deleted for channel ${channelId}`);
    res.json({ message: 'Watermark deleted successfully' });
  } catch (error) {
    logger.error('Failed to delete watermark', { error: error.message });
    res.status(500).json({ error: 'Failed to delete watermark' });
  }
});

export default router;
