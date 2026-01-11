import db from './database.js';
import fs from 'fs';
import path from 'path';

class MediaFile {
  // Create a new media file record
  static async create({ filename, original_name, file_path, file_size, duration, mime_type, user_id }) {
    const stmt = db.prepare(`
      INSERT INTO media_files (filename, original_name, file_path, file_size, duration, mime_type, user_id)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `);

    const result = await stmt.run(filename, original_name, file_path, file_size, duration, mime_type, user_id);
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

    // Delete physical file
    if (fs.existsSync(mediaFile.file_path)) {
      fs.unlinkSync(mediaFile.file_path);
    }

    const stmt = db.prepare('DELETE FROM media_files WHERE id = ?');
    await stmt.run(id);
    return true;
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
