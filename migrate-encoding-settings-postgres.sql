-- Migration: Add encoding settings and remove HLS settings (PostgreSQL)
-- Run this on your PostgreSQL database

BEGIN;

-- Remove obsolete HLS settings
DELETE FROM settings WHERE key IN ('hls_segment_duration', 'hls_list_size');

-- Add quality preset settings (480p)
INSERT INTO settings (key, value, description) VALUES
  ('quality_480p_width', '854', '480p output width'),
  ('quality_480p_height', '480', '480p output height'),
  ('quality_480p_bitrate', '2500', '480p video bitrate in kbps')
ON CONFLICT (key) DO NOTHING;

-- Add quality preset settings (720p)
INSERT INTO settings (key, value, description) VALUES
  ('quality_720p_width', '1280', '720p output width'),
  ('quality_720p_height', '720', '720p output height'),
  ('quality_720p_bitrate', '4000', '720p video bitrate in kbps')
ON CONFLICT (key) DO NOTHING;

-- Add quality preset settings (1080p)
INSERT INTO settings (key, value, description) VALUES
  ('quality_1080p_width', '1920', '1080p output width'),
  ('quality_1080p_height', '1080', '1080p output height'),
  ('quality_1080p_bitrate', '6000', '1080p video bitrate in kbps')
ON CONFLICT (key) DO NOTHING;

-- Add encoding parameter settings
INSERT INTO settings (key, value, description) VALUES
  ('ffmpeg_preset', 'veryfast', 'FFmpeg encoding preset (ultrafast, superfast, veryfast, faster, fast, medium, slow, slower, veryslow)'),
  ('ffmpeg_tune', 'zerolatency', 'FFmpeg tune option (film, animation, grain, stillimage, fastdecode, zerolatency)'),
  ('ffmpeg_profile', 'main', 'H.264 profile (baseline, main, high)'),
  ('ffmpeg_level', '4.1', 'H.264 level (3.0, 3.1, 4.0, 4.1, 4.2, 5.0, 5.1, 5.2)'),
  ('ffmpeg_fps', '30', 'Output frame rate (fps)'),
  ('ffmpeg_audio_bitrate', '128', 'Audio bitrate in kbps'),
  ('ffmpeg_audio_sample_rate', '48000', 'Audio sample rate in Hz'),
  ('ffmpeg_keyframe_interval', '60', 'Keyframe interval (GOP size) in frames')
ON CONFLICT (key) DO NOTHING;

COMMIT;

-- Verify migration
SELECT 'Migration completed! New settings count:', COUNT(*)
FROM settings
WHERE key LIKE 'quality_%' OR key LIKE 'ffmpeg_%';
