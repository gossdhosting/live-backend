import Database from 'better-sqlite3';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const dbPath = path.join(__dirname, 'data', 'streaming.db');
const db = new Database(dbPath);

console.log('🚀 Starting Multi-Tenant Migration...\n');

try {
  // Enable foreign keys
  db.pragma('foreign_keys = ON');

  // 1. Create plans table
  console.log('📋 Creating plans table...');
  db.exec(`
    CREATE TABLE IF NOT EXISTS plans (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL UNIQUE,
      description TEXT,
      price_monthly REAL NOT NULL DEFAULT 0,
      price_yearly REAL NOT NULL DEFAULT 0,
      max_concurrent_streams INTEGER NOT NULL DEFAULT 1,
      max_bitrate INTEGER NOT NULL DEFAULT 4000,
      max_stream_duration INTEGER,
      storage_limit_mb INTEGER NOT NULL DEFAULT 1000,
      custom_watermark INTEGER DEFAULT 0,
      is_active INTEGER DEFAULT 1,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `);
  console.log('✅ Plans table created\n');

  // 2. Insert default plans
  console.log('📝 Inserting default plans...');
  const insertPlan = db.prepare(`
    INSERT OR IGNORE INTO plans (name, description, price_monthly, price_yearly, max_concurrent_streams, max_bitrate, max_stream_duration, storage_limit_mb, custom_watermark)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  const plans = [
    {
      name: 'Free',
      description: 'Perfect for testing and small projects',
      price_monthly: 0,
      price_yearly: 0,
      max_concurrent_streams: 1,
      max_bitrate: 2500, // 480p max
      max_stream_duration: 60, // 60 minutes
      storage_limit_mb: 500,
      custom_watermark: 0
    },
    {
      name: 'Basic',
      description: 'For individuals and small creators',
      price_monthly: 29,
      price_yearly: 290, // ~20% discount
      max_concurrent_streams: 3,
      max_bitrate: 4000, // 720p max
      max_stream_duration: 240, // 4 hours
      storage_limit_mb: 5000,
      custom_watermark: 1
    },
    {
      name: 'Pro',
      description: 'For professionals and growing businesses',
      price_monthly: 99,
      price_yearly: 990,
      max_concurrent_streams: 10,
      max_bitrate: 6000, // 1080p max
      max_stream_duration: null, // unlimited
      storage_limit_mb: 50000,
      custom_watermark: 1
    },
    {
      name: 'Enterprise',
      description: 'For large organizations with custom needs',
      price_monthly: 299,
      price_yearly: 2990,
      max_concurrent_streams: 50,
      max_bitrate: 8000, // High quality
      max_stream_duration: null, // unlimited
      storage_limit_mb: 200000,
      custom_watermark: 1
    }
  ];

  plans.forEach(plan => {
    insertPlan.run(
      plan.name,
      plan.description,
      plan.price_monthly,
      plan.price_yearly,
      plan.max_concurrent_streams,
      plan.max_bitrate,
      plan.max_stream_duration,
      plan.storage_limit_mb,
      plan.custom_watermark
    );
    console.log(`  ✓ ${plan.name} plan added`);
  });
  console.log('✅ Default plans inserted\n');

  // 3. Update users table - add new columns
  console.log('👤 Updating users table...');
  const usersTableInfo = db.prepare('PRAGMA table_info(users)').all();
  const columnNames = usersTableInfo.map(col => col.name);

  const usersColumns = [
    { name: 'role', sql: "ALTER TABLE users ADD COLUMN role TEXT DEFAULT 'user'" },
    { name: 'plan_id', sql: 'ALTER TABLE users ADD COLUMN plan_id INTEGER REFERENCES plans(id)' },
    { name: 'subscription_type', sql: "ALTER TABLE users ADD COLUMN subscription_type TEXT DEFAULT 'monthly'" },
    { name: 'subscription_status', sql: "ALTER TABLE users ADD COLUMN subscription_status TEXT DEFAULT 'active'" },
    { name: 'subscription_started_at', sql: 'ALTER TABLE users ADD COLUMN subscription_started_at DATETIME' },
    { name: 'subscription_expires_at', sql: 'ALTER TABLE users ADD COLUMN subscription_expires_at DATETIME' },
    { name: 'status', sql: "ALTER TABLE users ADD COLUMN status TEXT DEFAULT 'active'" },
    { name: 'last_login_at', sql: 'ALTER TABLE users ADD COLUMN last_login_at DATETIME' },
    { name: 'last_login_ip', sql: 'ALTER TABLE users ADD COLUMN last_login_ip TEXT' }
  ];

  usersColumns.forEach(col => {
    if (!columnNames.includes(col.name)) {
      db.exec(col.sql);
      console.log(`  ✓ Added ${col.name} column`);
    } else {
      console.log(`  - ${col.name} column already exists`);
    }
  });
  console.log('✅ Users table updated\n');

  // 4. Assign free plan to existing users and set them as admin
  console.log('🔧 Updating existing users...');
  const freePlan = db.prepare('SELECT id FROM plans WHERE name = ?').get('Free');
  if (freePlan) {
    const updateUsers = db.prepare(`
      UPDATE users
      SET plan_id = ?,
          role = 'admin',
          subscription_status = 'active',
          subscription_started_at = CURRENT_TIMESTAMP
      WHERE plan_id IS NULL
    `);
    const result = updateUsers.run(freePlan.id);
    console.log(`  ✓ Updated ${result.changes} existing users to admin with Free plan\n`);
  }

  // 5. Update channels table - add user_id
  console.log('📺 Updating channels table...');
  const channelsTableInfo = db.prepare('PRAGMA table_info(channels)').all();
  const channelColumns = channelsTableInfo.map(col => col.name);

  if (!channelColumns.includes('user_id')) {
    db.exec('ALTER TABLE channels ADD COLUMN user_id INTEGER REFERENCES users(id) ON DELETE CASCADE');
    console.log('  ✓ Added user_id column to channels');

    // Assign all existing channels to the first admin user
    const firstAdmin = db.prepare("SELECT id FROM users WHERE role = 'admin' LIMIT 1").get();
    if (firstAdmin) {
      db.prepare('UPDATE channels SET user_id = ? WHERE user_id IS NULL').run(firstAdmin.id);
      console.log(`  ✓ Assigned existing channels to admin user (ID: ${firstAdmin.id})`);
    }
  } else {
    console.log('  - user_id column already exists');
  }
  console.log('✅ Channels table updated\n');

  // 6. Update platform_connections table - change user_id from TEXT to INTEGER
  console.log('🔗 Updating platform_connections table...');
  const platformTableInfo = db.prepare('PRAGMA table_info(platform_connections)').all();
  const userIdCol = platformTableInfo.find(col => col.name === 'user_id');

  if (userIdCol && userIdCol.type === 'TEXT') {
    console.log('  ⚠️  user_id is TEXT type, recreating table with INTEGER type...');

    // Create new table with correct schema
    db.exec(`
      CREATE TABLE IF NOT EXISTS platform_connections_new (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id INTEGER NOT NULL,
        platform TEXT NOT NULL,
        access_token TEXT NOT NULL,
        refresh_token TEXT,
        token_expires_at DATETIME,
        platform_user_id TEXT,
        platform_user_name TEXT,
        platform_user_email TEXT,
        platform_page_id TEXT,
        platform_page_name TEXT,
        platform_channel_id TEXT,
        platform_channel_name TEXT,
        scopes TEXT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
      )
    `);

    // Copy data (assign to first admin if exists)
    const firstAdmin = db.prepare("SELECT id FROM users WHERE role = 'admin' LIMIT 1").get();
    if (firstAdmin) {
      db.exec(`
        INSERT INTO platform_connections_new
        SELECT id, ${firstAdmin.id}, platform, access_token, refresh_token, token_expires_at,
               platform_user_id, platform_user_name, platform_user_email,
               platform_page_id, platform_page_name, platform_channel_id, platform_channel_name,
               scopes, created_at, updated_at
        FROM platform_connections
      `);
      console.log('  ✓ Copied existing platform connections to admin user');
    }

    // Drop old table and rename new one
    db.exec('DROP TABLE platform_connections');
    db.exec('ALTER TABLE platform_connections_new RENAME TO platform_connections');
    console.log('  ✓ Platform connections table recreated with INTEGER user_id');
  } else {
    console.log('  - user_id is already INTEGER type or table needs to be created');
  }
  console.log('✅ Platform connections table updated\n');

  // 7. Create/Update media_files table - add user_id
  console.log('📁 Updating media_files table...');

  // Check if media_files table exists
  const tableExists = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='media_files'").get();

  if (!tableExists) {
    // Create the table if it doesn't exist
    db.exec(`
      CREATE TABLE media_files (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
        filename TEXT NOT NULL,
        original_name TEXT NOT NULL,
        file_path TEXT NOT NULL,
        file_size INTEGER NOT NULL,
        duration REAL,
        mime_type TEXT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
      )
    `);
    console.log('  ✓ Created media_files table with user_id');
  } else {
    // Table exists, check if user_id column exists
    const mediaTableInfo = db.prepare('PRAGMA table_info(media_files)').all();
    const mediaColumns = mediaTableInfo.map(col => col.name);

    if (!mediaColumns.includes('user_id')) {
      db.exec('ALTER TABLE media_files ADD COLUMN user_id INTEGER REFERENCES users(id) ON DELETE CASCADE');
      console.log('  ✓ Added user_id column to media_files');

      // Assign all existing media to first admin
      const firstAdmin = db.prepare("SELECT id FROM users WHERE role = 'admin' LIMIT 1").get();
      if (firstAdmin) {
        db.prepare('UPDATE media_files SET user_id = ? WHERE user_id IS NULL').run(firstAdmin.id);
        console.log(`  ✓ Assigned existing media files to admin user (ID: ${firstAdmin.id})`);
      }
    } else {
      console.log('  - user_id column already exists');
    }
  }
  console.log('✅ Media files table updated\n');

  // 8. Create audit_logs table for activity tracking
  console.log('📊 Creating audit_logs table...');
  db.exec(`
    CREATE TABLE IF NOT EXISTS audit_logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER,
      action TEXT NOT NULL,
      resource_type TEXT,
      resource_id INTEGER,
      details TEXT,
      ip_address TEXT,
      user_agent TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE SET NULL
    )
  `);
  console.log('✅ Audit logs table created\n');

  console.log('✨ Multi-Tenant Migration Completed Successfully!\n');
  console.log('📋 Summary:');
  console.log('  - Plans table created with 4 default plans');
  console.log('  - Users table updated with role, plan, and subscription fields');
  console.log('  - Channels linked to users (ownership)');
  console.log('  - Platform connections linked to users');
  console.log('  - Media files linked to users');
  console.log('  - Audit logs table created');
  console.log('\n🎉 Ready for multi-tenant streaming platform!\n');

} catch (error) {
  console.error('❌ Migration failed:', error.message);
  console.error(error.stack);
  process.exit(1);
}

db.close();
