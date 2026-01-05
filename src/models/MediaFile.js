import db from './database.js';
import fs from 'fs';
import path from 'path';

class MediaFile {
  // Create a new media file record
  static create({ filename, original_name, file_path, file_size, duration, mime_type, user_id }) {
    const stmt = db.prepare(`
      INSERT INTO media_files (filename, original_name, file_path, file_size, duration, mime_type, user_id)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `);

    const result = stmt.run(filename, original_name, file_path, file_size, duration, mime_type, user_id);
    return this.findById(result.lastInsertRowid);
  }

  // Find media file by ID
  static findById(id) {
    const stmt = db.prepare('SELECT * FROM media_files WHERE id = ?');
    return stmt.get(id);
  }

  // Get all media files
  static findAll() {
    const stmt = db.prepare('SELECT * FROM media_files ORDER BY created_at DESC');
    return stmt.all();
  }

  // Get media files by user ID
  static findByUserId(userId) {
    const stmt = db.prepare('SELECT * FROM media_files WHERE user_id = ? ORDER BY created_at DESC');
    return stmt.all(userId);
  }

  // Delete media file
  static delete(id) {
    const mediaFile = this.findById(id);
    if (!mediaFile) return false;

    // Delete physical file
    if (fs.existsSync(mediaFile.file_path)) {
      fs.unlinkSync(mediaFile.file_path);
    }

    const stmt = db.prepare('DELETE FROM media_files WHERE id = ?');
    stmt.run(id);
    return true;
  }

  // Get total storage used
  static getTotalStorageUsed() {
    const stmt = db.prepare('SELECT SUM(file_size) as total FROM media_files');
    const result = stmt.get();
    return result.total || 0;
  }

  // Get total storage used by user
  static getTotalStorageUsedByUser(userId) {
    const stmt = db.prepare('SELECT SUM(file_size) as total FROM media_files WHERE user_id = ?');
    const result = stmt.get(userId);
    return result.total || 0;
  }

  // Get count
  static getCount() {
    const stmt = db.prepare('SELECT COUNT(*) as count FROM media_files');
    const result = stmt.get();
    return result.count;
  }

  // Get count by user
  static getCountByUser(userId) {
    const stmt = db.prepare('SELECT COUNT(*) as count FROM media_files WHERE user_id = ?');
    const result = stmt.get(userId);
    return result.count;
  }
}

export default MediaFile;
