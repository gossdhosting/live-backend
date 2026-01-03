import express from 'express';
import multer from 'multer';
import path from 'path';
import {
  getAllMedia,
  getMedia,
  uploadMedia,
  deleteMedia
} from '../controllers/mediaController.js';
import { authenticateToken } from '../middleware/auth.js';

const router = express.Router();

// Configure multer for video uploads
const upload = multer({
  dest: 'uploads/temp/',
  limits: {
    fileSize: 5 * 1024 * 1024 * 1024 // 5GB max file size
  },
  fileFilter: (req, file, cb) => {
    const allowedMimes = ['video/mp4', 'video/x-matroska', 'video/quicktime', 'video/x-msvideo', 'video/webm'];
    const allowedExts = ['.mp4', '.mkv', '.mov', '.avi', '.webm'];
    const ext = path.extname(file.originalname).toLowerCase();

    if (allowedMimes.includes(file.mimetype) || allowedExts.includes(ext)) {
      cb(null, true);
    } else {
      cb(new Error('Invalid file type. Only video files are allowed.'));
    }
  }
});

// All routes require authentication
router.use(authenticateToken);

// Get all media files
router.get('/', getAllMedia);

// Get single media file
router.get('/:id', getMedia);

// Upload media file
router.post('/upload', upload.single('file'), uploadMedia);

// Delete media file
router.delete('/:id', deleteMedia);

export default router;
