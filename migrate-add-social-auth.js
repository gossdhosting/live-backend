import Database from 'better-sqlite3';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const dbPath = process.env.DATABASE_PATH || path.join(__dirname, 'data', 'streaming.db');
const db = new Database(dbPath);

console.log('Running social auth migration...');
console.log(`Database: ${dbPath}`);

try {
  // Check if columns already exist
  const tableInfo = db.pragma('table_info(users)');
  const columns = tableInfo.map(col => col.name);

  // Check if password_hash is nullable
  const passwordHashCol = tableInfo.find(col => col.name === 'password_hash');
  const needsPasswordHashFix = passwordHashCol && passwordHashCol.notnull === 1;

  const columnsToAdd = [];

  if (!columns.includes('auth_provider')) {
    columnsToAdd.push({ name: 'auth_provider', definition: "TEXT DEFAULT 'local'" });
  }

  if (!columns.includes('firebase_uid')) {
    columnsToAdd.push({ name: 'firebase_uid', definition: 'TEXT' });
  }

  if (!columns.includes('email_verified')) {
    columnsToAdd.push({ name: 'email_verified', definition: 'INTEGER DEFAULT 0' });
  }

  if (!columns.includes('profile_picture')) {
    columnsToAdd.push({ name: 'profile_picture', definition: 'TEXT' });
  }

  if (columnsToAdd.length === 0 && !needsPasswordHashFix) {
    console.log('✓ All social auth columns already exist and password_hash is nullable');
  } else {
    // Add missing columns
    if (columnsToAdd.length > 0) {
      columnsToAdd.forEach(col => {
        console.log(`Adding column: ${col.name}`);
        db.exec(`ALTER TABLE users ADD COLUMN ${col.name} ${col.definition};`);
      });

      console.log(`✓ Added ${columnsToAdd.length} new column(s) for social authentication`);
    }

    // Make password_hash nullable if needed
    if (needsPasswordHashFix) {
      console.log('Making password_hash nullable for social login users...');

      db.exec(`
        BEGIN TRANSACTION;

        -- Create new table with password_hash as nullable
        CREATE TABLE users_new (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          email TEXT NOT NULL,
          password_hash TEXT,
          name TEXT,
          role TEXT DEFAULT 'user',
          plan_id INTEGER,
          subscription_type TEXT DEFAULT 'monthly',
          subscription_status TEXT DEFAULT 'active',
          subscription_started_at DATETIME,
          subscription_expires_at DATETIME,
          status TEXT DEFAULT 'active',
          last_login_at DATETIME,
          last_login_ip TEXT,
          created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
          updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
          auth_provider TEXT DEFAULT 'local',
          firebase_uid TEXT,
          email_verified INTEGER DEFAULT 0,
          profile_picture TEXT
        );

        -- Copy data from old table
        INSERT INTO users_new SELECT * FROM users;

        -- Drop old table
        DROP TABLE users;

        -- Rename new table
        ALTER TABLE users_new RENAME TO users;

        COMMIT;
      `);

      console.log('✓ password_hash is now nullable');
    }
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
  console.error(error);
  process.exit(1);
}

db.close();
