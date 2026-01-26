-- Add OneSignal player_id column to users table
-- This stores the OneSignal player ID for push notifications
-- The player_id is set when user logs in and cleared when user logs out

-- PostgreSQL syntax
ALTER TABLE users ADD COLUMN IF NOT EXISTS onesignal_player_id VARCHAR(255) DEFAULT NULL;

-- Add index for faster lookups when sending notifications
CREATE INDEX IF NOT EXISTS idx_users_onesignal_player_id ON users(onesignal_player_id);

-- Log the migration (PostgreSQL uses NOW() instead of datetime('now'))
INSERT INTO system_logs (level, message, metadata, created_at)
VALUES ('info', 'Migration: Added onesignal_player_id column to users table', '{}', NOW());
