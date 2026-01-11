-- PostgreSQL Migration Schema for Multi-Channel Streaming Platform
-- Migrated from SQLite on 2026-01-11

-- Drop existing tables if they exist (for clean migration)
DROP TABLE IF EXISTS platform_streams CASCADE;
DROP TABLE IF EXISTS platform_connections CASCADE;
DROP TABLE IF EXISTS rtmp_destinations CASCADE;
DROP TABLE IF EXISTS rtmp_templates CASCADE;
DROP TABLE IF EXISTS media_files CASCADE;
DROP TABLE IF EXISTS stream_logs CASCADE;
DROP TABLE IF EXISTS user_settings CASCADE;
DROP TABLE IF EXISTS settings CASCADE;
DROP TABLE IF EXISTS channels CASCADE;
DROP TABLE IF EXISTS users CASCADE;
DROP TABLE IF NOT EXISTS plans CASCADE;

-- Plans table
CREATE TABLE plans (
  id SERIAL PRIMARY KEY,
  name VARCHAR(100) NOT NULL UNIQUE,
  description TEXT,
  price_monthly DECIMAL(10,2) NOT NULL DEFAULT 0,
  price_yearly DECIMAL(10,2) NOT NULL DEFAULT 0,
  max_concurrent_streams INTEGER NOT NULL DEFAULT 1,
  max_bitrate INTEGER NOT NULL DEFAULT 4000,
  max_stream_duration INTEGER,
  storage_limit_mb INTEGER NOT NULL DEFAULT 1000,
  custom_watermark BOOLEAN DEFAULT FALSE,
  max_platform_connections INTEGER DEFAULT 1,
  youtube_restreaming BOOLEAN DEFAULT FALSE,
  is_active BOOLEAN DEFAULT TRUE,
  is_hidden BOOLEAN DEFAULT FALSE,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Users table
CREATE TABLE users (
  id SERIAL PRIMARY KEY,
  email VARCHAR(255) UNIQUE NOT NULL,
  password_hash VARCHAR(255),
  name VARCHAR(255),
  role VARCHAR(50) DEFAULT 'admin',
  plan_id INTEGER REFERENCES plans(id),
  subscription_status VARCHAR(50) DEFAULT 'active',
  subscription_start_date TIMESTAMP,
  subscription_end_date TIMESTAMP,
  firebase_uid VARCHAR(255) UNIQUE,
  provider VARCHAR(50),
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Channels table
CREATE TABLE channels (
  id SERIAL PRIMARY KEY,
  name VARCHAR(255) NOT NULL,
  description TEXT,
  input_url TEXT NOT NULL,
  input_type VARCHAR(50) DEFAULT 'youtube',
  output_path TEXT,
  status VARCHAR(50) DEFAULT 'stopped',
  process_id INTEGER,
  auto_restart BOOLEAN DEFAULT TRUE,
  error_message TEXT,
  last_started_at TIMESTAMP,
  last_stopped_at TIMESTAMP,
  user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
  media_file_id INTEGER,
  loop_video BOOLEAN DEFAULT FALSE,
  stream_key VARCHAR(50) UNIQUE,
  watermark_enabled BOOLEAN DEFAULT FALSE,
  watermark_path TEXT,
  watermark_position VARCHAR(50) DEFAULT 'top-left',
  watermark_opacity DECIMAL(3,2) DEFAULT 1.0,
  watermark_scale DECIMAL(3,2) DEFAULT 1.0,
  quality_preset VARCHAR(50) DEFAULT '720p',
  stream_title TEXT,
  title_enabled BOOLEAN DEFAULT FALSE,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Stream logs table
CREATE TABLE stream_logs (
  id SERIAL PRIMARY KEY,
  channel_id INTEGER NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
  log_type VARCHAR(50) NOT NULL,
  message TEXT,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Settings table (global/admin settings)
CREATE TABLE settings (
  key VARCHAR(100) PRIMARY KEY,
  value TEXT NOT NULL,
  description TEXT,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- User settings table (per-user preferences)
CREATE TABLE user_settings (
  id SERIAL PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  key VARCHAR(100) NOT NULL,
  value TEXT NOT NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(user_id, key)
);

-- RTMP templates table (global templates)
CREATE TABLE rtmp_templates (
  id SERIAL PRIMARY KEY,
  name VARCHAR(255) NOT NULL,
  platform VARCHAR(100) NOT NULL,
  rtmp_url TEXT NOT NULL,
  stream_key TEXT NOT NULL,
  video_bitrate VARCHAR(50),
  audio_bitrate VARCHAR(50),
  profile VARCHAR(50),
  preset VARCHAR(50),
  fps INTEGER,
  enabled BOOLEAN DEFAULT FALSE,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- RTMP destinations table (per-channel destinations)
CREATE TABLE rtmp_destinations (
  id SERIAL PRIMARY KEY,
  channel_id INTEGER NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
  template_id INTEGER REFERENCES rtmp_templates(id) ON DELETE SET NULL,
  platform VARCHAR(100) NOT NULL,
  rtmp_url TEXT NOT NULL,
  stream_key TEXT NOT NULL,
  enabled BOOLEAN DEFAULT TRUE,
  custom_bitrate INTEGER,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Media files table (uploaded videos)
CREATE TABLE media_files (
  id SERIAL PRIMARY KEY,
  filename VARCHAR(255) NOT NULL,
  original_name VARCHAR(255) NOT NULL,
  file_path TEXT NOT NULL,
  file_size BIGINT NOT NULL,
  duration DECIMAL(10,2),
  mime_type VARCHAR(100),
  user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Platform connections table (OAuth2 integrations)
CREATE TABLE platform_connections (
  id SERIAL PRIMARY KEY,
  platform VARCHAR(50) NOT NULL,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  access_token TEXT NOT NULL,
  refresh_token TEXT,
  token_expires_at TIMESTAMP,
  platform_user_id VARCHAR(255),
  platform_user_name VARCHAR(255),
  platform_user_email VARCHAR(255),
  platform_page_id VARCHAR(255),
  platform_page_name VARCHAR(255),
  platform_channel_id VARCHAR(255),
  platform_channel_name VARCHAR(255),
  available_pages TEXT,
  scopes TEXT,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Platform streams table (created streams on platforms)
CREATE TABLE platform_streams (
  id SERIAL PRIMARY KEY,
  channel_id INTEGER NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
  platform_connection_id INTEGER NOT NULL REFERENCES platform_connections(id) ON DELETE CASCADE,
  rtmp_destination_id INTEGER REFERENCES rtmp_destinations(id) ON DELETE CASCADE,
  platform VARCHAR(50) NOT NULL,
  platform_stream_id VARCHAR(255),
  platform_broadcast_id VARCHAR(255),
  rtmp_url TEXT NOT NULL,
  stream_key TEXT NOT NULL,
  stream_title TEXT,
  stream_description TEXT,
  status VARCHAR(50) DEFAULT 'created',
  enabled BOOLEAN DEFAULT TRUE,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Create indexes for performance
CREATE INDEX idx_channels_user_id ON channels(user_id);
CREATE INDEX idx_channels_status ON channels(status);
CREATE INDEX idx_channels_stream_key ON channels(stream_key);
CREATE INDEX idx_stream_logs_channel_id ON stream_logs(channel_id);
CREATE INDEX idx_stream_logs_created_at ON stream_logs(created_at);
CREATE INDEX idx_rtmp_destinations_channel_id ON rtmp_destinations(channel_id);
CREATE INDEX idx_rtmp_destinations_enabled ON rtmp_destinations(enabled);
CREATE INDEX idx_media_files_user_id ON media_files(user_id);
CREATE INDEX idx_platform_connections_user_id ON platform_connections(user_id);
CREATE INDEX idx_platform_connections_platform ON platform_connections(platform);
CREATE INDEX idx_platform_streams_channel_id ON platform_streams(channel_id);
CREATE INDEX idx_platform_streams_platform_connection_id ON platform_streams(platform_connection_id);
CREATE INDEX idx_user_settings_user_id ON user_settings(user_id);

-- Function to update updated_at timestamp
CREATE OR REPLACE FUNCTION update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = CURRENT_TIMESTAMP;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Create triggers for updated_at
CREATE TRIGGER update_plans_updated_at BEFORE UPDATE ON plans
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

CREATE TRIGGER update_users_updated_at BEFORE UPDATE ON users
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

CREATE TRIGGER update_channels_updated_at BEFORE UPDATE ON channels
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

CREATE TRIGGER update_settings_updated_at BEFORE UPDATE ON settings
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

CREATE TRIGGER update_user_settings_updated_at BEFORE UPDATE ON user_settings
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

CREATE TRIGGER update_rtmp_templates_updated_at BEFORE UPDATE ON rtmp_templates
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

CREATE TRIGGER update_rtmp_destinations_updated_at BEFORE UPDATE ON rtmp_destinations
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

CREATE TRIGGER update_platform_connections_updated_at BEFORE UPDATE ON platform_connections
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

CREATE TRIGGER update_platform_streams_updated_at BEFORE UPDATE ON platform_streams
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

-- Insert default settings
INSERT INTO settings (key, value, description) VALUES
('hls_segment_duration', '4', 'HLS segment duration in seconds'),
('hls_list_size', '6', 'Number of segments in playlist'),
('max_concurrent_streams', '10', 'Maximum concurrent streams allowed'),
('auto_restart_enabled', 'true', 'Global auto-restart toggle'),
('title_bg_color', '#000000', 'Title overlay background color'),
('title_opacity', '80', 'Title overlay background opacity (0-100)'),
('title_position', 'bottom-left', 'Title overlay position on video'),
('title_text_color', '#FFFFFF', 'Title overlay text color'),
('title_font_size', '32', 'Title overlay font size in pixels'),
('title_box_padding', '5', 'Title box padding in pixels (lower = less CPU usage)'),
('email_header', '<div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; padding: 20px; background: #f5f5f5;"><div style="background: white; padding: 20px; border-radius: 8px;">', 'HTML header added to all emails (logo, branding, etc.)'),
('email_footer', '</div><p style="text-align: center; color: #666; font-size: 12px; margin-top: 20px;">© 2026 ZebCast. All rights reserved.</p></div>', 'HTML footer added to all emails (copyright, unsubscribe, etc.)'),
('email_template_registration', '<h2>Welcome to ZebCast!</h2><p>Hi ${name},</p><p>Thank you for registering with ZebCast. Your account has been created successfully.</p><p>You can now log in and start streaming to multiple platforms simultaneously.</p><p>Best regards,<br>The ZebCast Team</p>', 'Registration email template. Variables: ${name}, ${email}'),
('email_template_forgot_password', '<h2>Reset Your Password</h2><p>Hi,</p><p>You requested to reset your password. Click the button below to reset it:</p><p style="margin: 20px 0;"><a href="${resetLink}" style="background-color: #3498db; color: white; padding: 12px 24px; text-decoration: none; border-radius: 4px; display: inline-block;">Reset Password</a></p><p>If you didn''t request this, you can safely ignore this email.</p><p>This link will expire in 1 hour.</p><p>Best regards,<br>The ZebCast Team</p>', 'Forgot password email template. Variables: ${resetLink} (required)');

COMMENT ON TABLE plans IS 'Subscription plans with features and limits';
COMMENT ON TABLE users IS 'User accounts with authentication and subscription info';
COMMENT ON TABLE channels IS 'Streaming channels configuration';
COMMENT ON TABLE stream_logs IS 'Stream activity logs';
COMMENT ON TABLE settings IS 'Global application settings';
COMMENT ON TABLE user_settings IS 'Per-user preferences and settings';
COMMENT ON TABLE rtmp_templates IS 'Reusable RTMP destination templates';
COMMENT ON TABLE rtmp_destinations IS 'Per-channel RTMP output destinations';
COMMENT ON TABLE media_files IS 'Uploaded video files for streaming';
COMMENT ON TABLE platform_connections IS 'OAuth2 connections to streaming platforms';
COMMENT ON TABLE platform_streams IS 'Created streams on external platforms';
