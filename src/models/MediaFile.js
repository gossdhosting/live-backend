import db from './database.js';
import fs from 'fs';
import path from 'path';
import S3Service from '../services/S3Service.js';

class MediaFile {
  // Create a new media file record
  static async create({ filename, original_name, file_path, file_size, duration, mime_type, user_id, s3_key, s3_bucket, s3_region, storage_type = 'local' }) {
    const stmt = db.prepare(`
      INSERT INTO media_files (filename, original_name, file_path, file_size, duration, mime_type, user_id, s3_key, s3_bucket, s3_region, storage_type)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    const result = await stmt.run(filename, original_name, file_path, file_size, duration, mime_type, user_id, s3_key, s3_bucket, s3_region, storage_type);
    return await this.findById(result.lastInsertRowid);
  }

  // Find media file by ID
  static async findById(id) {
    const stmt = db.prepare('SELECT * FROM media_files WHERE id = ?');
    return await stmt.get(id);
  }

  // Get all media files (with user info for admin)
  static async findAll() {
    const stmt = db.prepare(`
      SELECT
        m.*,
        u.email as user_email,
        u.name as user_name
      FROM media_files m
      LEFT JOIN users u ON m.user_id = u.id
      ORDER BY m.created_at DESC
    `);
    return await stmt.all();
  }

  // Get media files by user ID
  static async findByUserId(userId) {
    const stmt = db.prepare('SELECT * FROM media_files WHERE user_id = ? ORDER BY created_at DESC');
    return await stmt.all(userId);
  }

  // Delete media file
  static async delete(id) {
    const mediaFile = await this.findById(id);
    if (!mediaFile) return false;

    // Delete from S3 if stored there
    if (mediaFile.storage_type === 's3' && mediaFile.s3_key) {
      await S3Service.deleteFile(mediaFile.s3_key);
    }
    // Delete local file if exists
    else if (mediaFile.file_path && fs.existsSync(mediaFile.file_path)) {
      fs.unlinkSync(mediaFile.file_path);
    }

    const stmt = db.prepare('DELETE FROM media_files WHERE id = ?');
    await stmt.run(id);
    return true;
  }

  // Delete all media files for a user (used when user account is deleted)
  static async deleteAllByUserId(userId) {
    try {
      // Get all media files for this user
      const mediaFiles = await this.findByUserId(userId);

      let deletedCount = 0;
      for (const mediaFile of mediaFiles) {
        // Delete from S3 if stored there
        if (mediaFile.storage_type === 's3' && mediaFile.s3_key) {
          await S3Service.deleteFile(mediaFile.s3_key);
          deletedCount++;
        }
        // Delete local file if exists
        else if (mediaFile.file_path && fs.existsSync(mediaFile.file_path)) {
          fs.unlinkSync(mediaFile.file_path);
          deletedCount++;
        }
      }

      // Delete all database records
      const stmt = db.prepare('DELETE FROM media_files WHERE user_id = ?');
      await stmt.run(userId);

      return { success: true, deletedCount };
    } catch (error) {
      console.error('Error deleting user media files:', error);
      return { success: false, deletedCount: 0, error: error.message };
    }
  }

  // Get signed URL for S3 files
  static async getSignedUrl(id) {
    const mediaFile = await this.findById(id);
    if (!mediaFile) return null;

    if (mediaFile.storage_type === 's3' && mediaFile.s3_key) {
      return await S3Service.getSignedUrl(mediaFile.s3_key);
    }

    // Return local file path for local storage
    return mediaFile.file_path;
  }

  // Get total storage used
  static async getTotalStorageUsed() {
    const stmt = db.prepare('SELECT SUM(file_size) as total FROM media_files');
    const result = await stmt.get();
    return result.total || 0;
  }

  // Get total storage used by user
  static async getTotalStorageUsedByUser(userId) {
    const stmt = db.prepare('SELECT SUM(file_size) as total FROM media_files WHERE user_id = ?');
    const result = await stmt.get(userId);
    return result.total || 0;
  }

  // Get count
  static async getCount() {
    const stmt = db.prepare('SELECT COUNT(*) as count FROM media_files');
    const result = await stmt.get();
    return result.count;
  }

  // Get count by user
  static async getCountByUser(userId) {
    const stmt = db.prepare('SELECT COUNT(*) as count FROM media_files WHERE user_id = ?');
    const result = await stmt.get(userId);
    return result.count;
  }
}

export default MediaFile;
