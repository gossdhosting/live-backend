import Database from 'better-sqlite3';
import path from 'path';
import fs from 'fs';
import crypto from 'crypto';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Ensure data directory exists
const dataDir = path.join(process.cwd(), 'data');
if (!fs.existsSync(dataDir)) {
  fs.mkdirSync(dataDir, { recursive: true });
}

const dbPath = process.env.DATABASE_PATH || path.join(dataDir, 'streaming.db');
const db = new Database(dbPath);

// Enable foreign keys
db.pragma('foreign_keys = ON');

// Initialize database schema
const initDatabase = () => {
  // Users table (for admin authentication)
  db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      email TEXT UNIQUE NOT NULL,
      password_hash TEXT NOT NULL,
      name TEXT,
      role TEXT DEFAULT 'admin',
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `);

  // Channels table
  db.exec(`
    CREATE TABLE IF NOT EXISTS channels (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      description TEXT,
      input_url TEXT NOT NULL,
      output_path TEXT,
      status TEXT DEFAULT 'stopped',
      process_id INTEGER,
      auto_restart INTEGER DEFAULT 1,
      error_message TEXT,
      last_started_at DATETIME,
      last_stopped_at DATETIME,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `);

  // Stream logs table
  db.exec(`
    CREATE TABLE IF NOT EXISTS stream_logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      channel_id INTEGER NOT NULL,
      log_type TEXT NOT NULL,
      message TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (channel_id) REFERENCES channels(id) ON DELETE CASCADE
    )
  `);

  // Settings table (global/admin settings)
  db.exec(`
    CREATE TABLE IF NOT EXISTS settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL,
      description TEXT,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `);

  // User settings table (per-user title preferences)
  db.exec(`
    CREATE TABLE IF NOT EXISTS user_settings (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      key TEXT NOT NULL,
      value TEXT NOT NULL,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
      UNIQUE(user_id, key)
    )
  `);

  // Global RTMP templates table (configured once, used by all channels)
  db.exec(`
    CREATE TABLE IF NOT EXISTS rtmp_templates (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      platform TEXT NOT NULL,
      rtmp_url TEXT NOT NULL,
      stream_key TEXT NOT NULL,
      video_bitrate TEXT DEFAULT NULL,
      audio_bitrate TEXT DEFAULT NULL,
      profile TEXT DEFAULT NULL,
      preset TEXT DEFAULT NULL,
      fps INTEGER DEFAULT NULL,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `);

  // RTMP destinations table (per-channel enable/disable of templates)
  db.exec(`
    CREATE TABLE IF NOT EXISTS rtmp_destinations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      channel_id INTEGER NOT NULL,
      template_id INTEGER,
      platform TEXT NOT NULL,
      rtmp_url TEXT NOT NULL,
      stream_key TEXT NOT NULL,
      enabled INTEGER DEFAULT 1,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (channel_id) REFERENCES channels(id) ON DELETE CASCADE,
      FOREIGN KEY (template_id) REFERENCES rtmp_templates(id) ON DELETE SET NULL
    )
  `);

  // Media files table (for pre-recorded videos)
  db.exec(`
    CREATE TABLE IF NOT EXISTS media_files (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      filename TEXT NOT NULL,
      original_name TEXT NOT NULL,
      file_path TEXT NOT NULL,
      file_size INTEGER NOT NULL,
      duration REAL,
      mime_type TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `);

  // Insert default settings
  const defaultSettings = [
    {
      key: 'hls_segment_duration',
      value: process.env.HLS_SEGMENT_DURATION || '4',
      description: 'HLS segment duration in seconds',
    },
    {
      key: 'hls_list_size',
      value: process.env.HLS_LIST_SIZE || '6',
      description: 'Number of segments in playlist',
    },
    {
      key: 'max_concurrent_streams',
      value: process.env.MAX_CONCURRENT_STREAMS || '10',
      description: 'Maximum concurrent streams allowed',
    },
    {
      key: 'auto_restart_enabled',
      value: process.env.AUTO_RESTART_ENABLED || 'true',
      description: 'Global auto-restart toggle',
    },
    {
      key: 'title_bg_color',
      value: '#000000',
      description: 'Title overlay background color',
    },
    {
      key: 'title_opacity',
      value: '80',
      description: 'Title overlay background opacity (0-100)',
    },
    {
      key: 'title_position',
      value: 'bottom-left',
      description: 'Title overlay position on video',
    },
    {
      key: 'title_text_color',
      value: '#FFFFFF',
      description: 'Title overlay text color',
    },
    {
      key: 'title_font_size',
      value: '32',
      description: 'Title overlay font size in pixels',
    },
    {
      key: 'title_box_padding',
      value: '5',
      description: 'Title box padding in pixels (lower = less CPU usage)',
    },
  ];

  const insertSetting = db.prepare(`
    INSERT OR IGNORE INTO settings (key, value, description)
    VALUES (?, ?, ?)
  `);

  defaultSettings.forEach((setting) => {
    insertSetting.run(setting.key, setting.value, setting.description);
  });

  // Add watermark columns if they don't exist (migration)
  try {
    const tableInfo = db.prepare('PRAGMA table_info(channels)').all();
    const hasWatermarkEnabled = tableInfo.some(col => col.name === 'watermark_enabled');
    const hasWatermarkScale = tableInfo.some(col => col.name === 'watermark_scale');
    const hasQualityPreset = tableInfo.some(col => col.name === 'quality_preset');

    if (!hasWatermarkEnabled) {
      db.exec(`
        ALTER TABLE channels ADD COLUMN watermark_enabled INTEGER DEFAULT 0;
        ALTER TABLE channels ADD COLUMN watermark_path TEXT;
        ALTER TABLE channels ADD COLUMN watermark_position TEXT DEFAULT 'top-left';
        ALTER TABLE channels ADD COLUMN watermark_opacity REAL DEFAULT 1.0;
      `);
      console.log('✅ Added watermark columns to channels table');
    }

    if (!hasWatermarkScale) {
      db.exec(`
        ALTER TABLE channels ADD COLUMN watermark_scale REAL DEFAULT 1.0;
      `);
      console.log('✅ Added watermark_scale column to channels table');
    }

    if (!hasQualityPreset) {
      db.exec(`
        ALTER TABLE channels ADD COLUMN quality_preset TEXT DEFAULT '720p';
      `);
      console.log('✅ Added quality_preset column to channels table');
    }

    const hasStreamTitle = tableInfo.some(col => col.name === 'stream_title');
    if (!hasStreamTitle) {
      db.exec(`
        ALTER TABLE channels ADD COLUMN stream_title TEXT;
      `);
      console.log('✅ Added stream_title column to channels table');
    }

    const hasInputType = tableInfo.some(col => col.name === 'input_type');
    if (!hasInputType) {
      db.exec(`
        ALTER TABLE channels ADD COLUMN input_type TEXT DEFAULT 'youtube';
        ALTER TABLE channels ADD COLUMN media_file_id INTEGER;
        ALTER TABLE channels ADD COLUMN loop_video INTEGER DEFAULT 0;
      `);
      console.log('✅ Added input_type, media_file_id, and loop_video columns to channels table');
    }

    const hasTitleEnabled = tableInfo.some(col => col.name === 'title_enabled');
    if (!hasTitleEnabled) {
      db.exec(`
        ALTER TABLE channels ADD COLUMN title_enabled INTEGER DEFAULT 0;
      `);
      console.log('✅ Added title_enabled column to channels table');
    }

    const hasStreamKey = tableInfo.some(col => col.name === 'stream_key');
    if (!hasStreamKey) {
      // Add column without UNIQUE constraint (SQLite limitation)
      db.exec(`
        ALTER TABLE channels ADD COLUMN stream_key TEXT;
      `);
      console.log('✅ Added stream_key column to channels table');

      // Generate unique stream keys for existing channels
      const channels = db.prepare('SELECT id FROM channels WHERE stream_key IS NULL').all();
      for (const channel of channels) {
        const streamKey = crypto.randomBytes(5).toString('hex').substring(0, 9).toUpperCase();
        db.prepare('UPDATE channels SET stream_key = ? WHERE id = ?').run(streamKey, channel.id);
      }
      console.log(`✅ Generated stream keys for ${channels.length} existing channels`);

      // Create unique index on stream_key
      try {
        db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS idx_channels_stream_key ON channels(stream_key);`);
        console.log('✅ Created unique index on stream_key');
      } catch (err) {
        console.log('Note: Unique index on stream_key:', err.message);
      }
    }
  } catch (error) {
    console.log('Watermark columns migration:', error.message);
  }

  // Add user_id column to media_files if it doesn't exist (migration for multi-tenant)
  try {
    const mediaTableInfo = db.prepare('PRAGMA table_info(media_files)').all();
    const hasUserId = mediaTableInfo.some(col => col.name === 'user_id');

    if (!hasUserId) {
      db.exec(`
        ALTER TABLE media_files ADD COLUMN user_id INTEGER;
      `);
      console.log('✅ Added user_id column to media_files table');

      // Assign all existing media files to first admin user
      const firstAdmin = db.prepare("SELECT id FROM users WHERE role = 'admin' ORDER BY id LIMIT 1").get();
      if (firstAdmin) {
        db.exec(`UPDATE media_files SET user_id = ${firstAdmin.id} WHERE user_id IS NULL`);
        console.log(`✅ Assigned existing media files to admin user ${firstAdmin.id}`);
      }
    }
  } catch (error) {
    console.log('Media files user_id migration:', error.message);
  }

  // Add template_id column to rtmp_destinations if it doesn't exist (migration)
  try {
    const rtmpTableInfo = db.prepare('PRAGMA table_info(rtmp_destinations)').all();
    const hasTemplateId = rtmpTableInfo.some(col => col.name === 'template_id');
    const hasCustomBitrate = rtmpTableInfo.some(col => col.name === 'custom_bitrate');

    if (!hasTemplateId) {
      db.exec(`
        ALTER TABLE rtmp_destinations ADD COLUMN template_id INTEGER REFERENCES rtmp_templates(id) ON DELETE SET NULL;
      `);
      console.log('✅ Added template_id column to rtmp_destinations table');
    }

    if (!hasCustomBitrate) {
      db.exec(`
        ALTER TABLE rtmp_destinations ADD COLUMN custom_bitrate INTEGER;
      `);
      console.log('✅ Added custom_bitrate column to rtmp_destinations table');
    }
  } catch (error) {
    console.log('RTMP migrations:', error.message);
  }

  // Add enabled column to rtmp_templates if it doesn't exist (migration)
  try {
    const templatesTableInfo = db.prepare('PRAGMA table_info(rtmp_templates)').all();
    const hasEnabled = templatesTableInfo.some(col => col.name === 'enabled');

    if (!hasEnabled) {
      db.exec(`
        ALTER TABLE rtmp_templates ADD COLUMN enabled INTEGER DEFAULT 1;
      `);
      console.log('✅ Added enabled column to rtmp_templates table');
    }
  } catch (error) {
    console.log('RTMP templates enabled migration:', error.message);
  }

  // Platform connections table for OAuth2 integrations
  db.exec(`
    CREATE TABLE IF NOT EXISTS platform_connections (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      platform TEXT NOT NULL,
      user_id TEXT NOT NULL,
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
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `);

  // Platform streams table for tracking created streams
  db.exec(`
    CREATE TABLE IF NOT EXISTS platform_streams (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      channel_id INTEGER NOT NULL,
      platform_connection_id INTEGER NOT NULL,
      platform TEXT NOT NULL,
      platform_stream_id TEXT,
      platform_broadcast_id TEXT,
      rtmp_url TEXT NOT NULL,
      stream_key TEXT NOT NULL,
      stream_title TEXT,
      stream_description TEXT,
      status TEXT DEFAULT 'created',
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (channel_id) REFERENCES channels(id) ON DELETE CASCADE,
      FOREIGN KEY (platform_connection_id) REFERENCES platform_connections(id) ON DELETE CASCADE
    )
  `);

  // Add rtmp_destination_id column if it doesn't exist (migration for precise deletion tracking)
  try {
    const platformStreamsInfo = db.prepare('PRAGMA table_info(platform_streams)').all();
    const hasRtmpDestId = platformStreamsInfo.some(col => col.name === 'rtmp_destination_id');

    if (!hasRtmpDestId) {
      db.exec(`
        ALTER TABLE platform_streams ADD COLUMN rtmp_destination_id INTEGER REFERENCES rtmp_destinations(id) ON DELETE SET NULL;
      `);
      console.log('✅ Added rtmp_destination_id column to platform_streams table');
    }
  } catch (error) {
    console.log('Platform streams migration:', error.message);
  }

  console.log('✅ Database initialized successfully');
};

// Initialize on import
initDatabase();

export default db;
