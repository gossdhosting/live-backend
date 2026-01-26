import express from 'express';
import multer from 'multer';
import path from 'path';
import {
  getAllMedia,
  getMedia,
  uploadMedia,
  deleteMedia,
  getMediaUrl
} from '../controllers/mediaController.js';
import { authenticateToken } from '../middleware/auth.js';
import { checkPlanLimit } from '../middleware/permissions.js';

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

// Get signed URL for media file (for streaming/download)
router.get('/:id/url', getMediaUrl);

// Upload media file
router.post('/upload', upload.single('file'), checkPlanLimit('media'), uploadMedia);

// Delete media file
router.delete('/:id', deleteMedia);

export default router;
