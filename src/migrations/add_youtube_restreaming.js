import Database from 'better-sqlite3';
import path from 'path';

const dbPath = process.env.DATABASE_PATH || path.join(process.cwd(), 'data', 'streaming.db');
const db = new Database(dbPath);

console.log('Starting migration: Add youtube_restreaming columns...');

try {
  // Check if column exists in users table
  const userColumns = db.prepare("PRAGMA table_info(users)").all();
  const hasUserColumn = userColumns.some(col => col.name === 'youtube_restreaming');

  if (!hasUserColumn) {
    console.log('Adding youtube_restreaming column to users table...');
    db.exec(`
      ALTER TABLE users ADD COLUMN youtube_restreaming INTEGER DEFAULT 0;
    `);
    console.log('✓ Added youtube_restreaming to users table');
  } else {
    console.log('✓ youtube_restreaming column already exists in users table');
  }

  // Check if column exists in plans table
  const planColumns = db.prepare("PRAGMA table_info(plans)").all();
  const hasPlanColumn = planColumns.some(col => col.name === 'youtube_restreaming');

  if (!hasPlanColumn) {
    console.log('Adding youtube_restreaming column to plans table...');
    db.exec(`
      ALTER TABLE plans ADD COLUMN youtube_restreaming INTEGER DEFAULT 0;
    `);
    console.log('✓ Added youtube_restreaming to plans table');
  } else {
    console.log('✓ youtube_restreaming column already exists in plans table');
  }

  console.log('Migration completed successfully!');
} catch (error) {
  console.error('Migration failed:', error);
  process.exit(1);
} finally {
  db.close();
}
