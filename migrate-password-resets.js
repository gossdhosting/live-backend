import Database from 'better-sqlite3';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const dbPath = process.env.DATABASE_PATH || path.join(__dirname, 'data', 'streaming.db');
const db = new Database(dbPath);

console.log('Running password resets migration...');

try {
  // Check if table exists
  const tableExists = db.prepare(`
    SELECT name FROM sqlite_master
    WHERE type='table' AND name='password_resets'
  `).get();

  if (!tableExists) {
    console.log('Creating password_resets table...');

    db.exec(`
      CREATE TABLE password_resets (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id INTEGER NOT NULL,
        email TEXT NOT NULL,
        token TEXT NOT NULL UNIQUE,
        expires_at DATETIME NOT NULL,
        used_at DATETIME,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
      );

      CREATE INDEX idx_password_resets_token ON password_resets(token);
      CREATE INDEX idx_password_resets_user_id ON password_resets(user_id);
      CREATE INDEX idx_password_resets_expires_at ON password_resets(expires_at);
    `);

    console.log('✓ password_resets table created successfully');
  } else {
    console.log('✓ password_resets table already exists');
  }

  console.log('Migration completed successfully!');
} catch (error) {
  console.error('Migration failed:', error);
  process.exit(1);
} finally {
  db.close();
}
