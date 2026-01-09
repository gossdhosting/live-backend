import Database from 'better-sqlite3';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const db = new Database(path.join(__dirname, 'database.db'));

console.log('Running social auth migration...');

try {
  // Check if columns already exist
  const tableInfo = db.pragma('table_info(users)');
  const columns = tableInfo.map(col => col.name);

  const columnsToAdd = [];

  if (!columns.includes('auth_provider')) {
    columnsToAdd.push({ name: 'auth_provider', definition: "TEXT DEFAULT 'local'" });
  }

  if (!columns.includes('firebase_uid')) {
    columnsToAdd.push({ name: 'firebase_uid', definition: 'TEXT UNIQUE' });
  }

  if (!columns.includes('email_verified')) {
    columnsToAdd.push({ name: 'email_verified', definition: 'INTEGER DEFAULT 0' });
  }

  if (!columns.includes('profile_picture')) {
    columnsToAdd.push({ name: 'profile_picture', definition: 'TEXT' });
  }

  if (columnsToAdd.length === 0) {
    console.log('✓ All social auth columns already exist');
  } else {
    // Add missing columns
    columnsToAdd.forEach(col => {
      console.log(`Adding column: ${col.name}`);
      db.exec(`ALTER TABLE users ADD COLUMN ${col.name} ${col.definition};`);
    });

    console.log(`✓ Added ${columnsToAdd.length} new column(s) for social authentication`);
  }

  // Update existing users to have 'local' auth provider if null
  const updateStmt = db.prepare("UPDATE users SET auth_provider = 'local' WHERE auth_provider IS NULL");
  const result = updateStmt.run();

  if (result.changes > 0) {
    console.log(`✓ Updated ${result.changes} existing users with 'local' auth provider`);
  }

  console.log('✓ Migration completed successfully!');
} catch (error) {
  console.error('Migration failed:', error.message);
  process.exit(1);
}

db.close();
