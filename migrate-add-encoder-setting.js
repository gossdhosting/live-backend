import Database from 'better-sqlite3';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const dbPath = process.env.DATABASE_PATH || path.join(process.cwd(), 'data', 'streaming.db');

console.log('🔄 Starting encoder setting migration...');
console.log(`📂 Database: ${dbPath}`);

const db = new Database(dbPath);

try {
  // Start transaction
  db.exec('BEGIN TRANSACTION');

  // Add ffmpeg_encoder setting
  const insertSetting = db.prepare(`
    INSERT OR IGNORE INTO settings (key, value, description)
    VALUES (?, ?, ?)
  `);

  const result = insertSetting.run(
    'ffmpeg_encoder',
    'libx264',
    'FFmpeg video encoder (libx264, h264_nvenc, h264_qsv, h264_videotoolbox)'
  );

  // Commit transaction
  db.exec('COMMIT');

  console.log('✅ Migration completed successfully!');
  if (result.changes > 0) {
    console.log('   - Added ffmpeg_encoder setting (default: libx264)');
  } else {
    console.log('   - ffmpeg_encoder setting already exists, skipped');
  }

  // Verify
  const setting = db.prepare('SELECT * FROM settings WHERE key = ?').get('ffmpeg_encoder');
  if (setting) {
    console.log(`✅ Verified: ${setting.key} = ${setting.value}`);
  } else {
    console.log('⚠️  Warning: Could not verify ffmpeg_encoder setting');
  }

} catch (error) {
  db.exec('ROLLBACK');
  console.error('❌ Migration failed:', error.message);
  process.exit(1);
} finally {
  db.close();
}
