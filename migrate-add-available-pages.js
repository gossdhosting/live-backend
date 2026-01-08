import Database from 'better-sqlite3';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const dbPath = path.join(__dirname, 'data', 'streaming.db');
const db = new Database(dbPath);

console.log('Adding available_pages column to platform_connections table...');

try {
  // Check if column already exists
  const tableInfo = db.pragma('table_info(platform_connections)');
  const columnExists = tableInfo.some(col => col.name === 'available_pages');

  if (!columnExists) {
    db.exec(`
      ALTER TABLE platform_connections ADD COLUMN available_pages TEXT;
    `);
    console.log('✓ Column available_pages added successfully');
  } else {
    console.log('✓ Column available_pages already exists');
  }

  console.log('Migration completed successfully!');
} catch (error) {
  console.error('Migration failed:', error.message);
  process.exit(1);
} finally {
  db.close();
}
