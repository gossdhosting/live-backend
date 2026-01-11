// Determine which database to use based on environment
// Note: dotenv.config() is already called in server.js
const dbType = process.env.DB_TYPE || 'sqlite';

let db;

if (dbType === 'postgresql') {
  console.log('🐘 Using PostgreSQL database');
  const { default: pgDb } = await import('./database-postgresql.js');
  db = pgDb;
} else {
  console.log('📦 Using SQLite database');
  const { default: sqliteDb } = await import('./database-sqlite.js');
  db = sqliteDb;
}

export default db;
