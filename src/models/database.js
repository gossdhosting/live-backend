import Database from 'better-sqlite3';
import path from 'path';
import fs from 'fs';
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

  // Settings table
  db.exec(`
    CREATE TABLE IF NOT EXISTS settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL,
      description TEXT,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
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
  ];

  const insertSetting = db.prepare(`
    INSERT OR IGNORE INTO settings (key, value, description)
    VALUES (?, ?, ?)
  `);

  defaultSettings.forEach((setting) => {
    insertSetting.run(setting.key, setting.value, setting.description);
  });

  console.log('✅ Database initialized successfully');
};

// Initialize on import
initDatabase();

export default db;
