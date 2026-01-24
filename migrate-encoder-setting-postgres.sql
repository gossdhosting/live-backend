-- Migration: Add hardware encoder setting (PostgreSQL)
-- Run this on your PostgreSQL database

BEGIN;

-- Add encoder setting
INSERT INTO settings (key, value, description) VALUES
  ('ffmpeg_encoder', 'libx264', 'FFmpeg video encoder (libx264, h264_nvenc, h264_qsv, h264_videotoolbox)')
ON CONFLICT (key) DO NOTHING;

COMMIT;

-- Verify migration
SELECT 'Migration completed! Encoder setting:', key, value
FROM settings
WHERE key = 'ffmpeg_encoder';
