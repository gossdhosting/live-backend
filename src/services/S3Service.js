import { S3Client, PutObjectCommand, DeleteObjectCommand, GetObjectCommand, ListObjectsV2Command } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import logger from '../utils/logger.js';
import Settings from '../models/Settings.js';

class S3Service {
  constructor() {
    this.client = null;
    this.bucket = null;
    this.region = null;
    this.initialized = false;
  }

  /**
   * Initialize S3 client with credentials from settings
   */
  async initialize() {
    try {
      // Get AWS settings from database or environment variables
      const awsAccessKeySetting = await Settings.get('aws_access_key_id');
      const awsSecretKeySetting = await Settings.get('aws_secret_access_key');
      const awsRegionSetting = await Settings.get('aws_region');
      const s3BucketSetting = await Settings.get('s3_bucket_name');

      const awsAccessKey = awsAccessKeySetting?.value || process.env.AWS_ACCESS_KEY_ID;
      const awsSecretKey = awsSecretKeySetting?.value || process.env.AWS_SECRET_ACCESS_KEY;
      const awsRegion = awsRegionSetting?.value || process.env.AWS_REGION || 'us-east-1';
      const s3Bucket = s3BucketSetting?.value || process.env.S3_BUCKET_NAME;

      if (!awsAccessKey || !awsSecretKey || !s3Bucket) {
        logger.warn('AWS S3 not configured. Media will be stored locally.');
        this.initialized = false;
        return false;
      }

      this.region = awsRegion;
      this.bucket = s3Bucket;

      this.client = new S3Client({
        region: this.region,
        credentials: {
          accessKeyId: awsAccessKey,
          secretAccessKey: awsSecretKey,
        },
      });

      this.initialized = true;
      logger.info('S3Service initialized successfully', { bucket: this.bucket, region: this.region });
      return true;
    } catch (error) {
      logger.error('Failed to initialize S3Service', { error: error.message });
      this.initialized = false;
      return false;
    }
  }

  /**
   * Check if S3 is configured and available
   */
  async isAvailable() {
    if (!this.initialized) {
      await this.initialize();
    }
    return this.initialized;
  }

  /**
   * Generate S3 key for media file
   * @param {number} userId - User ID
   * @param {string} filename - Original filename
   * @returns {string} S3 key
   */
  generateMediaKey(userId, filename) {
    const timestamp = Date.now();
    const random = Math.random().toString(36).substring(7);
    const ext = filename.substring(filename.lastIndexOf('.'));
    return `media/${userId}/${timestamp}-${random}${ext}`;
  }

  /**
   * Upload file to S3
   * @param {Buffer} fileBuffer - File buffer
   * @param {string} key - S3 key
   * @param {string} contentType - MIME type
   * @returns {Promise<{success: boolean, key: string, url: string}>}
   */
  async uploadFile(fileBuffer, key, contentType) {
    try {
      if (!await this.isAvailable()) {
        throw new Error('S3 is not configured');
      }

      const command = new PutObjectCommand({
        Bucket: this.bucket,
        Key: key,
        Body: fileBuffer,
        ContentType: contentType,
      });

      await this.client.send(command);

      const url = `https://${this.bucket}.s3.${this.region}.amazonaws.com/${key}`;

      logger.info('File uploaded to S3', { key, bucket: this.bucket });

      return {
        success: true,
        key,
        url,
        bucket: this.bucket,
      };
    } catch (error) {
      logger.error('S3 upload failed', { error: error.message, key });
      throw error;
    }
  }

  /**
   * Delete file from S3
   * @param {string} key - S3 key
   * @returns {Promise<boolean>}
   */
  async deleteFile(key) {
    try {
      if (!await this.isAvailable()) {
        logger.warn('S3 not configured, skipping delete', { key });
        return false;
      }

      const command = new DeleteObjectCommand({
        Bucket: this.bucket,
        Key: key,
      });

      await this.client.send(command);

      logger.info('File deleted from S3', { key, bucket: this.bucket });
      return true;
    } catch (error) {
      logger.error('S3 delete failed', { error: error.message, key });
      return false;
    }
  }

  /**
   * Generate signed URL for secure file access
   * @param {string} key - S3 key
   * @param {number} expiresIn - URL expiration in seconds (default: 900 = 15 minutes)
   * @returns {Promise<string>}
   */
  async getSignedUrl(key, expiresIn = 900) {
    try {
      if (!await this.isAvailable()) {
        throw new Error('S3 is not configured');
      }

      const command = new GetObjectCommand({
        Bucket: this.bucket,
        Key: key,
      });

      const signedUrl = await getSignedUrl(this.client, command, { expiresIn });

      return signedUrl;
    } catch (error) {
      logger.error('Failed to generate signed URL', { error: error.message, key });
      throw error;
    }
  }

  /**
   * List all files for a user
   * @param {number} userId - User ID
   * @returns {Promise<Array>}
   */
  async listUserFiles(userId) {
    try {
      if (!await this.isAvailable()) {
        return [];
      }

      const command = new ListObjectsV2Command({
        Bucket: this.bucket,
        Prefix: `media/${userId}/`,
      });

      const response = await this.client.send(command);
      return response.Contents || [];
    } catch (error) {
      logger.error('Failed to list user files', { error: error.message, userId });
      return [];
    }
  }

  /**
   * Delete all files for a user (used when user account is deleted)
   * @param {number} userId - User ID
   * @returns {Promise<{success: boolean, deletedCount: number}>}
   */
  async deleteUserFiles(userId) {
    try {
      if (!await this.isAvailable()) {
        logger.warn('S3 not configured, skipping user files deletion', { userId });
        return { success: false, deletedCount: 0 };
      }

      const files = await this.listUserFiles(userId);

      if (files.length === 0) {
        logger.info('No S3 files found for user', { userId });
        return { success: true, deletedCount: 0 };
      }

      let deletedCount = 0;
      for (const file of files) {
        const deleted = await this.deleteFile(file.Key);
        if (deleted) deletedCount++;
      }

      logger.info('Deleted all S3 files for user', { userId, deletedCount });
      return { success: true, deletedCount };
    } catch (error) {
      logger.error('Failed to delete user files from S3', { error: error.message, userId });
      return { success: false, deletedCount: 0 };
    }
  }

  /**
   * Test S3 connection
   * @returns {Promise<{success: boolean, message: string}>}
   */
  async testConnection() {
    try {
      if (!await this.isAvailable()) {
        return { success: false, message: 'S3 is not configured' };
      }

      // Try to list objects to test connection
      const command = new ListObjectsV2Command({
        Bucket: this.bucket,
        MaxKeys: 1,
      });

      await this.client.send(command);

      return {
        success: true,
        message: 'S3 connection successful',
        bucket: this.bucket,
        region: this.region,
      };
    } catch (error) {
      return {
        success: false,
        message: error.message,
      };
    }
  }
}

// Create singleton instance
const s3Service = new S3Service();

export default s3Service;
