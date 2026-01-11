import Database from 'better-sqlite3';
import pg from 'pg';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import dotenv from 'dotenv';

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const { Pool } = pg;

// SQLite database
const sqliteDbPath = process.env.SQLITE_DB_PATH || path.join(process.cwd(), 'data', 'streaming.db');
const sqliteDb = new Database(sqliteDbPath, { readonly: true });

// PostgreSQL connection
const pgPool = new Pool({
  host: process.env.PG_HOST || 'localhost',
  port: process.env.PG_PORT || 5432,
  database: process.env.PG_DATABASE || 'streaming',
  user: process.env.PG_USER || 'postgres',
  password: process.env.PG_PASSWORD,
});

console.log('🔄 Starting migration from SQLite to PostgreSQL\n');

// Table migration order (respecting foreign keys)
const tables = [
  'plans',
  'users',
  'channels',
  'stream_logs',
  'settings',
  'user_settings',
  'rtmp_templates',
  'rtmp_destinations',
  'media_files',
  'platform_connections',
  'platform_streams'
];

// Convert SQLite boolean integers to PostgreSQL booleans
function convertBoolean(value) {
  if (value === null || value === undefined) return null;
  return value === 1 || value === true;
}

// Convert SQLite datetime to PostgreSQL timestamp
function convertTimestamp(value) {
  if (!value) return null;
  return value;
}

// Map SQLite column values to PostgreSQL format
function mapRowData(table, row) {
  const mapped = { ...row };

  // Convert boolean fields
  const booleanFields = {
    plans: ['custom_watermark', 'is_active', 'is_hidden', 'youtube_restreaming'],
    users: [],
    channels: ['auto_restart', 'loop_video', 'watermark_enabled', 'title_enabled'],
    rtmp_templates: ['enabled'],
    rtmp_destinations: ['enabled'],
    platform_streams: ['enabled']
  };

  if (booleanFields[table]) {
    booleanFields[table].forEach(field => {
      if (mapped[field] !== undefined) {
        mapped[field] = convertBoolean(mapped[field]);
      }
    });
  }

  // Convert timestamp fields
  const timestampFields = ['created_at', 'updated_at', 'last_started_at', 'last_stopped_at',
    'subscription_start_date', 'subscription_end_date', 'token_expires_at'];

  timestampFields.forEach(field => {
    if (mapped[field] !== undefined) {
      mapped[field] = convertTimestamp(mapped[field]);
    }
  });

  return mapped;
}

async function migrateTable(tableName) {
  try {
    console.log(`📋 Migrating table: ${tableName}`);

    // Get all rows from SQLite
    const rows = sqliteDb.prepare(`SELECT * FROM ${tableName}`).all();

    if (rows.length === 0) {
      console.log(`   ⚠️  No data to migrate\n`);
      return;
    }

    // Get column names from first row
    const columns = Object.keys(rows[0]);
    const columnsWithoutId = columns.filter(col => col !== 'id');

    // Build INSERT query
    const placeholders = columnsWithoutId.map((_, i) => `$${i + 1}`).join(', ');
    const insertQuery = `
      INSERT INTO ${tableName} (${columnsWithoutId.join(', ')})
      VALUES (${placeholders})
    `;

    // Insert each row
    let successCount = 0;
    for (const row of rows) {
      try {
        const mappedRow = mapRowData(tableName, row);
        const values = columnsWithoutId.map(col => mappedRow[col]);
        await pgPool.query(insertQuery, values);
        successCount++;
      } catch (error) {
        console.error(`   ❌ Error inserting row:`, error.message);
        console.error(`   Row data:`, row);
      }
    }

    // Reset sequence for id column
    await pgPool.query(`
      SELECT setval(pg_get_serial_sequence('${tableName}', 'id'),
        COALESCE((SELECT MAX(id) FROM ${tableName}), 1), true)
    `);

    console.log(`   ✅ ${successCount}/${rows.length} rows migrated\n`);

  } catch (error) {
    console.error(`   ❌ Error migrating table ${tableName}:`, error.message);
    throw error;
  }
}

async function main() {
  try {
    // Test PostgreSQL connection
    console.log('🔌 Testing PostgreSQL connection...');
    await pgPool.query('SELECT NOW()');
    console.log('   ✅ Connected to PostgreSQL\n');

    // Migrate each table
    for (const table of tables) {
      await migrateTable(table);
    }

    // Verify migration
    console.log('📊 Migration Summary:');
    for (const table of tables) {
      const sqliteCount = sqliteDb.prepare(`SELECT COUNT(*) as count FROM ${table}`).get();
      const pgResult = await pgPool.query(`SELECT COUNT(*) FROM ${table}`);
      const pgCount = pgResult.rows[0].count;

      const status = sqliteCount.count == pgCount ? '✅' : '⚠️';
      console.log(`   ${status} ${table}: SQLite=${sqliteCount.count}, PostgreSQL=${pgCount}`);
    }

    console.log('\n🎉 Migration completed successfully!');

  } catch (error) {
    console.error('\n❌ Migration failed:', error);
    process.exit(1);
  } finally {
    sqliteDb.close();
    await pgPool.end();
  }
}

main();
