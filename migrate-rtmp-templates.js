import Database from 'better-sqlite3';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const dbPath = path.join(__dirname, 'database.sqlite');
const db = new Database(dbPath);

console.log('Starting migration: Add encoding columns to rtmp_templates table...');

try {
  // Check if columns already exist
  const tableInfo = db.prepare("PRAGMA table_info(rtmp_templates)").all();
  const columnNames = tableInfo.map(col => col.name);

  const columnsToAdd = [
    { name: 'video_bitrate', type: 'TEXT DEFAULT NULL' },
    { name: 'audio_bitrate', type: 'TEXT DEFAULT NULL' },
    { name: 'profile', type: 'TEXT DEFAULT NULL' },
    { name: 'preset', type: 'TEXT DEFAULT NULL' },
    { name: 'fps', type: 'INTEGER DEFAULT NULL' },
  ];

  for (const column of columnsToAdd) {
    if (!columnNames.includes(column.name)) {
      console.log(`Adding column: ${column.name}`);
      db.exec(`ALTER TABLE rtmp_templates ADD COLUMN ${column.name} ${column.type}`);
      console.log(`✓ Added ${column.name}`);
    } else {
      console.log(`✓ Column ${column.name} already exists`);
    }
  }

  console.log('Migration completed successfully!');
} catch (error) {
  console.error('Migration failed:', error.message);
  process.exit(1);
}

db.close();
