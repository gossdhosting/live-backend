-- Migration: Add scheduled streaming feature
-- Date: 2026-01-18
-- Description: Adds scheduled streaming support with timezone and plan-based access control

-- Step 1: Add schedule_enabled feature flag to plans table
ALTER TABLE plans ADD COLUMN IF NOT EXISTS schedule_enabled BOOLEAN DEFAULT FALSE;

COMMENT ON COLUMN plans.schedule_enabled IS 'Allow users to schedule streams to start automatically';

-- Step 2: Create scheduled_streams table
CREATE TABLE IF NOT EXISTS scheduled_streams (
  id SERIAL PRIMARY KEY,
  channel_id INTEGER NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  scheduled_start_time TIMESTAMP NOT NULL,
  timezone VARCHAR(100) NOT NULL DEFAULT 'UTC',
  status VARCHAR(50) DEFAULT 'pending',
  started_at TIMESTAMP,
  cancelled_at TIMESTAMP,
  error_message TEXT,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Create indexes for performance
CREATE INDEX IF NOT EXISTS idx_scheduled_streams_channel_id ON scheduled_streams(channel_id);
CREATE INDEX IF NOT EXISTS idx_scheduled_streams_user_id ON scheduled_streams(user_id);
CREATE INDEX IF NOT EXISTS idx_scheduled_streams_status ON scheduled_streams(status);
CREATE INDEX IF NOT EXISTS idx_scheduled_streams_scheduled_start_time ON scheduled_streams(scheduled_start_time);
CREATE INDEX IF NOT EXISTS idx_scheduled_streams_status_start_time ON scheduled_streams(status, scheduled_start_time);

-- Add trigger for updated_at
CREATE TRIGGER update_scheduled_streams_updated_at BEFORE UPDATE ON scheduled_streams
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

COMMENT ON TABLE scheduled_streams IS 'Scheduled stream start times with timezone support';
COMMENT ON COLUMN scheduled_streams.status IS 'pending, started, cancelled, failed, completed';
COMMENT ON COLUMN scheduled_streams.timezone IS 'IANA timezone identifier (e.g., America/New_York, Asia/Kolkata)';
COMMENT ON COLUMN scheduled_streams.scheduled_start_time IS 'UTC timestamp when stream should start';
