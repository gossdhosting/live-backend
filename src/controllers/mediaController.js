import MediaFile from '../models/MediaFile.js';
import logger from '../utils/logger.js';
import path from 'path';
import fs from 'fs';
import { spawn } from 'child_process';
import S3Service from '../services/S3Service.js';

// Get all media files
export const getAllMedia = async (req, res) => {
  try {
    const userId = req.user.id;
    const isAdmin = req.user.role === 'admin';

    // Admins see all media, users see only their own
    const mediaFiles = isAdmin ? await MediaFile.findAll() : await MediaFile.findByUserId(userId);
    const totalStorage = isAdmin ? await MediaFile.getTotalStorageUsed() : await MediaFile.getTotalStorageUsedByUser(userId);

    res.json({
      mediaFiles,
      totalStorage,
      totalCount: mediaFiles.length
    });
  } catch (error) {
    logger.error('Get all media error', { error: error.message, userId: req.user?.id });
    res.status(500).json({ error: 'Internal server error' });
  }
};

// Get single media file
export const getMedia = async (req, res) => {
  try {
    const { id } = req.params;
    const mediaFile = await MediaFile.findById(id);

    if (!mediaFile) {
      return res.status(404).json({ error: 'Media file not found' });
    }

    // Check ownership (admins can access all)
    if (req.user.role !== 'admin' && mediaFile.user_id !== req.user.id) {
      return res.status(403).json({ error: 'Access denied: not media file owner' });
    }

    // If file is stored on S3, generate signed URL
    if (mediaFile.storage_type === 's3' && mediaFile.s3_key) {
      const signedUrl = await MediaFile.getSignedUrl(id);
      mediaFile.access_url = signedUrl;
    }

    res.json({ mediaFile });
  } catch (error) {
    logger.error('Get media error', { error: error.message, userId: req.user?.id });
    res.status(500).json({ error: 'Internal server error' });
  }
};

// Upload media file
export const uploadMedia = async (req, res) => {
  let tempFilePath = null;

  try {
    if (!req.file) {
      return res.status(400).json({ error: 'No file uploaded' });
    }

    const file = req.file;
    tempFilePath = file.path;

    // Check if S3 is configured AND user's plan allows cloud storage
    const s3Available = await S3Service.isAvailable();
    const userPlanAllowsCloudStorage = req.user.cloud_storage_enabled === true || req.user.cloud_storage_enabled === 1;

    let mediaFileData = {
      original_name: file.originalname,
      file_size: file.size,
      mime_type: file.mimetype,
      user_id: req.user.id
    };

    if (s3Available && userPlanAllowsCloudStorage) {
      // Upload to S3
      logger.info('Uploading media to S3', { userId: req.user.id, filename: file.originalname });

      // Read file buffer
      const fileBuffer = fs.readFileSync(file.path);

      // Generate S3 key
      const s3Key = S3Service.generateMediaKey(req.user.id, file.originalname);

      // Upload to S3
      const s3Result = await S3Service.uploadFile(fileBuffer, s3Key, file.mimetype);

      // Get video duration using ffprobe (before deleting temp file)
      const duration = await getVideoDuration(file.path);

      // Delete temp file
      fs.unlinkSync(file.path);
      tempFilePath = null;

      // Create database record with S3 info
      mediaFileData = {
        ...mediaFileData,
        filename: path.basename(s3Key),
        file_path: s3Result.url,  // Store S3 URL
        duration,
        s3_key: s3Result.key,
        s3_bucket: s3Result.bucket,
        s3_region: process.env.AWS_REGION || 'us-east-1',
        storage_type: 's3'
      };

      logger.info('Media file uploaded to S3', {
        userId: req.user.id,
        filename: file.originalname,
        s3Key: s3Result.key
      });
    } else {
      // Fallback to local storage
      logger.info('S3 not configured, using local storage', { userId: req.user.id });

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
      tempFilePath = null;

      // Get video duration using ffprobe
      const duration = await getVideoDuration(filePath);

      mediaFileData = {
        ...mediaFileData,
        filename,
        file_path: filePath,
        duration,
        storage_type: 'local'
      };

      logger.info('Media file uploaded locally', {
        userId: req.user.id,
        filename: file.originalname,
        filePath
      });
    }

    // Create database record
    const mediaFile = await MediaFile.create(mediaFileData);

    logger.info('Media file record created', {
      mediaId: mediaFile.id,
      userId: req.user.id,
      storageType: mediaFileData.storage_type
    });

    res.status(201).json({ mediaFile });
  } catch (error) {
    // Clean up temp file if it still exists
    if (tempFilePath && fs.existsSync(tempFilePath)) {
      try {
        fs.unlinkSync(tempFilePath);
      } catch (cleanupError) {
        logger.error('Failed to clean up temp file', { error: cleanupError.message });
      }
    }

    logger.error('Upload media error', { error: error.message, stack: error.stack });
    res.status(500).json({ error: 'Failed to upload media file: ' + error.message });
  }
};

// Delete media file
export const deleteMedia = async (req, res) => {
  try {
    const { id } = req.params;
    const mediaFile = await MediaFile.findById(id);

    if (!mediaFile) {
      return res.status(404).json({ error: 'Media file not found' });
    }

    // Check ownership (admins can delete all)
    if (req.user.role !== 'admin' && mediaFile.user_id !== req.user.id) {
      return res.status(403).json({ error: 'Access denied: not media file owner' });
    }

    const success = await MediaFile.delete(id);

    if (!success) {
      return res.status(404).json({ error: 'Media file not found' });
    }

    logger.info('Media file deleted', { mediaId: id, userId: req.user.id });
    res.json({ message: 'Media file deleted successfully' });
  } catch (error) {
    logger.error('Delete media error', { error: error.message, userId: req.user?.id });
    res.status(500).json({ error: 'Internal server error' });
  }
};

// Get signed URL for media file (for streaming)
export const getMediaUrl = async (req, res) => {
  try {
    const { id } = req.params;
    const mediaFile = await MediaFile.findById(id);

    if (!mediaFile) {
      return res.status(404).json({ error: 'Media file not found' });
    }

    // Check ownership (admins can access all)
    if (req.user.role !== 'admin' && mediaFile.user_id !== req.user.id) {
      return res.status(403).json({ error: 'Access denied: not media file owner' });
    }

    // Get access URL
    let accessUrl;
    if (mediaFile.storage_type === 's3' && mediaFile.s3_key) {
      accessUrl = await MediaFile.getSignedUrl(id);
    } else {
      accessUrl = mediaFile.file_path;
    }

    logger.info('Media URL generated', { mediaId: id, userId: req.user.id, storageType: mediaFile.storage_type });
    res.json({
      url: accessUrl,
      storage_type: mediaFile.storage_type,
      expires_in: mediaFile.storage_type === 's3' ? 900 : null  // 15 minutes for S3
    });
  } catch (error) {
    logger.error('Get media URL error', { error: error.message, userId: req.user?.id });
    res.status(500).json({ error: 'Failed to generate media URL' });
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
