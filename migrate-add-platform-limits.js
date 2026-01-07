import Database from 'better-sqlite3';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const dbPath = path.join(__dirname, 'data', 'streaming.db');
const db = new Database(dbPath);

console.log('🚀 Starting migration: Add platform limits and default watermark...\n');

try {
  db.exec('BEGIN TRANSACTION');

  // 1. Add max_platform_connections to plans table
  console.log('📝 Adding max_platform_connections to plans table...');

  // Check if column already exists
  const columns = db.prepare("PRAGMA table_info(plans)").all();
  const hasMaxPlatformConnections = columns.some(col => col.name === 'max_platform_connections');

  if (!hasMaxPlatformConnections) {
    db.exec(`
      ALTER TABLE plans
      ADD COLUMN max_platform_connections INTEGER DEFAULT 1
    `);
    console.log('✅ Added max_platform_connections column to plans\n');

    // Update existing plans with reasonable defaults
    console.log('📝 Updating existing plans with platform connection limits...');
    db.prepare(`UPDATE plans SET max_platform_connections = 1 WHERE name = 'Free'`).run();
    db.prepare(`UPDATE plans SET max_platform_connections = 3 WHERE name = 'Basic'`).run();
    db.prepare(`UPDATE plans SET max_platform_connections = 5 WHERE name = 'Pro'`).run();
    db.prepare(`UPDATE plans SET max_platform_connections = 10 WHERE name = 'Enterprise'`).run();
    console.log('✅ Updated existing plans\n');
  } else {
    console.log('⚠️  max_platform_connections column already exists, skipping\n');
  }

  // 2. Insert default watermark settings into existing settings table
  console.log('📝 Inserting default watermark settings...');
  const insertSetting = db.prepare(`
    INSERT OR IGNORE INTO settings (key, value, description, updated_at)
    VALUES (?, ?, ?, CURRENT_TIMESTAMP)
  `);

  insertSetting.run(
    'default_watermark_path',
    '',
    'Path to default watermark image shown when users do not have custom watermark permissions'
  );

  insertSetting.run(
    'default_watermark_enabled',
    '1',
    'Whether to show default watermark for users without custom watermark permission (1=yes, 0=no)'
  );

  insertSetting.run(
    'default_watermark_position',
    'bottom-right',
    'Position of default watermark (top-left, top-right, bottom-left, bottom-right, center)'
  );

  insertSetting.run(
    'default_watermark_opacity',
    '0.7',
    'Opacity of default watermark (0.0 to 1.0)'
  );

  insertSetting.run(
    'default_watermark_scale',
    '0.15',
    'Scale of default watermark relative to video size (0.0 to 1.0)'
  );

  console.log('✅ Default watermark settings inserted\n');

  db.exec('COMMIT');
  console.log('✅ Migration completed successfully!\n');

  // Show current plans
  console.log('📊 Current plans configuration:');
  const plans = db.prepare(`
    SELECT name, max_concurrent_streams, max_platform_connections, custom_watermark, storage_limit_mb
    FROM plans
    WHERE is_active = 1
    ORDER BY price_monthly ASC
  `).all();

  console.table(plans);

  // Show default watermark settings
  console.log('\n📊 Default watermark settings:');
  const watermarkSettings = db.prepare(`
    SELECT key, value, description
    FROM settings
    WHERE key LIKE 'default_watermark%'
    ORDER BY key
  `).all();

  console.table(watermarkSettings);

} catch (error) {
  db.exec('ROLLBACK');
  console.error('❌ Migration failed:', error.message);
  console.error(error.stack);
  process.exit(1);
} finally {
  db.close();
}

console.log('\n✅ Migration script finished');
console.log('\n📝 Next steps:');
console.log('1. Restart the backend server');
console.log('2. Upload a default watermark in Admin Settings');
console.log('3. Test platform connection limits with different plans\n');
