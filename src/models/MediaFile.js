import db from './database.js';
import fs from 'fs';
import path from 'path';

class MediaFile {
  // Create a new media file record
  static create({ filename, original_name, file_path, file_size, duration, mime_type }) {
    const stmt = db.prepare(`
      INSERT INTO media_files (filename, original_name, file_path, file_size, duration, mime_type)
      VALUES (?, ?, ?, ?, ?, ?)
    `);

    const result = stmt.run(filename, original_name, file_path, file_size, duration, mime_type);
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

  // Get count
  static getCount() {
    const stmt = db.prepare('SELECT COUNT(*) as count FROM media_files');
    const result = stmt.get();
    return result.count;
  }
}

export default MediaFile;
