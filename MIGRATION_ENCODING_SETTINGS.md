# Migration: Add Encoding Settings and Remove HLS Settings

This migration adds configurable FFmpeg encoding settings to the admin panel and removes obsolete HLS settings.

## What This Migration Does

### 1. Removes Obsolete HLS Settings
- `hls_segment_duration` - No longer used (HLS output removed)
- `hls_list_size` - No longer used (HLS output removed)

### 2. Adds Quality Preset Settings
Configurable resolution and bitrate for each quality level:

**480p:**
- `quality_480p_width` (default: 854)
- `quality_480p_height` (default: 480)
- `quality_480p_bitrate` (default: 2500 kbps)

**720p:**
- `quality_720p_width` (default: 1280)
- `quality_720p_height` (default: 720)
- `quality_720p_bitrate` (default: 4000 kbps)

**1080p:**
- `quality_1080p_width` (default: 1920)
- `quality_1080p_height` (default: 1080)
- `quality_1080p_bitrate` (default: 6000 kbps)

### 3. Adds Encoding Parameter Settings
Configurable FFmpeg encoding parameters:

- `ffmpeg_preset` (default: veryfast) - CPU/quality tradeoff
- `ffmpeg_tune` (default: zerolatency) - Encoding optimization
- `ffmpeg_profile` (default: main) - H.264 profile
- `ffmpeg_level` (default: 4.1) - H.264 level
- `ffmpeg_fps` (default: 30) - Output frame rate
- `ffmpeg_audio_bitrate` (default: 128 kbps) - Audio bitrate
- `ffmpeg_audio_sample_rate` (default: 48000 Hz) - Audio sample rate
- `ffmpeg_keyframe_interval` (default: 60 frames) - GOP size

## How to Run This Migration

### For SQLite (Default)

```bash
cd backend
node migrate-add-encoding-settings.js
```

### For PostgreSQL

The migration script uses SQLite by default. For PostgreSQL, you'll need to manually run the SQL commands or adapt the script.

**Manual SQL for PostgreSQL:**

```sql
BEGIN;

-- Remove obsolete HLS settings
DELETE FROM settings WHERE key IN ('hls_segment_duration', 'hls_list_size');

-- Add quality preset settings
INSERT INTO settings (key, value, description) VALUES
  -- 480p
  ('quality_480p_width', '854', '480p output width'),
  ('quality_480p_height', '480', '480p output height'),
  ('quality_480p_bitrate', '2500', '480p video bitrate in kbps'),
  -- 720p
  ('quality_720p_width', '1280', '720p output width'),
  ('quality_720p_height', '720', '720p output height'),
  ('quality_720p_bitrate', '4000', '720p video bitrate in kbps'),
  -- 1080p
  ('quality_1080p_width', '1920', '1080p output width'),
  ('quality_1080p_height', '1080', '1080p output height'),
  ('quality_1080p_bitrate', '6000', '1080p video bitrate in kbps'),
  -- Encoding parameters
  ('ffmpeg_preset', 'veryfast', 'FFmpeg encoding preset'),
  ('ffmpeg_tune', 'zerolatency', 'FFmpeg tune option'),
  ('ffmpeg_profile', 'main', 'H.264 profile'),
  ('ffmpeg_level', '4.1', 'H.264 level'),
  ('ffmpeg_fps', '30', 'Output frame rate (fps)'),
  ('ffmpeg_audio_bitrate', '128', 'Audio bitrate in kbps'),
  ('ffmpeg_audio_sample_rate', '48000', 'Audio sample rate in Hz'),
  ('ffmpeg_keyframe_interval', '60', 'Keyframe interval (GOP size) in frames')
ON CONFLICT (key) DO NOTHING;

COMMIT;
```

## What Gets Updated

### Backend Files Modified:
- ✅ `backend/src/models/database-sqlite.js` - Default settings updated
- ✅ `backend/src/ffmpeg/StreamManager.js` - Uses database settings for encoding

### Frontend Files Modified:
- ✅ `admin-panel/src/pages/AdminSettings.jsx` - New admin UI for settings

### New Files:
- ✅ `backend/migrate-add-encoding-settings.js` - Migration script

## After Migration

1. **Restart the backend server** to load the new settings
2. **Access the Admin Settings** in the admin panel
3. **Configure encoding settings** under the "System" tab:
   - Quality Presets (480p, 720p, 1080p)
   - Encoding Parameters (preset, tune, profile, etc.)
4. **Restart existing streams** for new settings to take effect

## Important Notes

⚠️ **Changes apply to newly started streams only!**
- Existing running streams will continue using their original settings
- You must stop and restart streams for new encoding settings to apply

⚠️ **HLS URLs no longer work!**
- All HLS endpoints have been removed
- Streams now only output to RTMP destinations (Facebook, YouTube, Twitch, etc.)

## Rollback (If Needed)

To rollback this migration:

```sql
BEGIN;

-- Restore HLS settings
INSERT INTO settings (key, value, description) VALUES
  ('hls_segment_duration', '4', 'HLS segment duration in seconds'),
  ('hls_list_size', '6', 'Number of segments in playlist');

-- Remove new encoding settings
DELETE FROM settings WHERE key LIKE 'quality_%' OR key LIKE 'ffmpeg_%';

COMMIT;
```

Then restore the previous version of the code files.

## Verification

After running the migration, verify it worked:

```bash
# Check database
sqlite3 backend/data/database.sqlite "SELECT key FROM settings WHERE key LIKE 'quality_%' OR key LIKE 'ffmpeg_%';"

# Should show 17 new settings (9 quality + 8 encoding)
```

## Support

If you encounter issues, check:
1. Database permissions
2. Backend logs in `backend/logs/`
3. FFmpeg logs in `backend/logs/ffmpeg/`
