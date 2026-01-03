import MediaFile from '../models/MediaFile.js';
import logger from '../utils/logger.js';
import path from 'path';
import fs from 'fs';
import { spawn } from 'child_process';

// Get all media files
export const getAllMedia = (req, res) => {
  try {
    const mediaFiles = MediaFile.findAll();
    const totalStorage = MediaFile.getTotalStorageUsed();

    res.json({
      mediaFiles,
      totalStorage,
      totalCount: mediaFiles.length
    });
  } catch (error) {
    logger.error('Get all media error', { error: error.message });
    res.status(500).json({ error: 'Internal server error' });
  }
};

// Get single media file
export const getMedia = (req, res) => {
  try {
    const { id } = req.params;
    const mediaFile = MediaFile.findById(id);

    if (!mediaFile) {
      return res.status(404).json({ error: 'Media file not found' });
    }

    res.json({ mediaFile });
  } catch (error) {
    logger.error('Get media error', { error: error.message });
    res.status(500).json({ error: 'Internal server error' });
  }
};

// Upload media file
export const uploadMedia = async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: 'No file uploaded' });
    }

    const file = req.file;
    const uploadDir = process.env.MEDIA_UPLOAD_PATH || path.join(process.cwd(), 'uploads', 'media');

    // Ensure upload directory exists
    if (!fs.existsSync(uploadDir)) {
      fs.mkdirSync(uploadDir, { recursive: true });
    }

    // Generate unique filename
    const filename = `${Date.now()}-${Math.random().toString(36).substring(7)}${path.extname(file.originalname)}`;
    const filePath = path.join(uploadDir, filename);

    // Move file to upload directory
    fs.renameSync(file.path, filePath);

    // Get video duration using ffprobe
    const duration = await getVideoDuration(filePath);

    // Create database record
    const mediaFile = MediaFile.create({
      filename,
      original_name: file.originalname,
      file_path: filePath,
      file_size: file.size,
      duration,
      mime_type: file.mimetype
    });

    logger.info('Media file uploaded', {
      mediaId: mediaFile.id,
      filename: file.originalname,
      size: file.size
    });

    res.status(201).json({ mediaFile });
  } catch (error) {
    logger.error('Upload media error', { error: error.message });
    res.status(500).json({ error: 'Failed to upload media file' });
  }
};

// Delete media file
export const deleteMedia = (req, res) => {
  try {
    const { id } = req.params;
    const success = MediaFile.delete(id);

    if (!success) {
      return res.status(404).json({ error: 'Media file not found' });
    }

    logger.info('Media file deleted', { mediaId: id });
    res.json({ message: 'Media file deleted successfully' });
  } catch (error) {
    logger.error('Delete media error', { error: error.message });
    res.status(500).json({ error: 'Internal server error' });
  }
};

// Helper function to get video duration using ffprobe
function getVideoDuration(filePath) {
  return new Promise((resolve, reject) => {
    const ffprobe = spawn('ffprobe', [
      '-v', 'error',
      '-show_entries', 'format=duration',
      '-of', 'default=noprint_wrappers=1:nokey=1',
      filePath
    ]);

    let duration = '';

    ffprobe.stdout.on('data', (data) => {
      duration += data.toString();
    });

    ffprobe.on('close', (code) => {
      if (code === 0) {
        const durationInSeconds = parseFloat(duration.trim());
        resolve(isNaN(durationInSeconds) ? null : durationInSeconds);
      } else {
        resolve(null);
      }
    });

    ffprobe.on('error', () => {
      resolve(null);
    });
  });
}
