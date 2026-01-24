import Database from 'better-sqlite3';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Database path
const dbPath = process.env.DATABASE_PATH || path.join(__dirname, 'data', 'database.sqlite');

console.log('Starting migration: Add encoding settings and remove HLS settings');
console.log('Database path:', dbPath);

const db = new Database(dbPath);

try {
  // Start transaction
  db.prepare('BEGIN').run();

  console.log('\n1. Removing obsolete HLS settings...');

  // Remove HLS settings
  const deleteHLS = db.prepare('DELETE FROM settings WHERE key IN (?, ?)');
  const result = deleteHLS.run('hls_segment_duration', 'hls_list_size');
  console.log(`   Removed ${result.changes} HLS settings`);

  console.log('\n2. Adding new quality preset settings...');

  // New quality preset settings
  const qualitySettings = [
    // 480p settings
    {
      key: 'quality_480p_width',
      value: '854',
      description: '480p output width'
    },
    {
      key: 'quality_480p_height',
      value: '480',
      description: '480p output height'
    },
    {
      key: 'quality_480p_bitrate',
      value: '2500',
      description: '480p video bitrate in kbps'
    },
    // 720p settings
    {
      key: 'quality_720p_width',
      value: '1280',
      description: '720p output width'
    },
    {
      key: 'quality_720p_height',
      value: '720',
      description: '720p output height'
    },
    {
      key: 'quality_720p_bitrate',
      value: '4000',
      description: '720p video bitrate in kbps'
    },
    // 1080p settings
    {
      key: 'quality_1080p_width',
      value: '1920',
      description: '1080p output width'
    },
    {
      key: 'quality_1080p_height',
      value: '1080',
      description: '1080p output height'
    },
    {
      key: 'quality_1080p_bitrate',
      value: '6000',
      description: '1080p video bitrate in kbps'
    }
  ];

  console.log('\n3. Adding encoding parameter settings...');

  // Encoding parameter settings
  const encodingSettings = [
    {
      key: 'ffmpeg_preset',
      value: 'veryfast',
      description: 'FFmpeg encoding preset (ultrafast, superfast, veryfast, faster, fast, medium, slow, slower, veryslow)'
    },
    {
      key: 'ffmpeg_profile',
      value: 'main',
      description: 'H.264 profile (baseline, main, high)'
    },
    {
      key: 'ffmpeg_level',
      value: '4.1',
      description: 'H.264 level (3.0, 3.1, 4.0, 4.1, 4.2, 5.0, 5.1, 5.2)'
    },
    {
      key: 'ffmpeg_fps',
      value: '30',
      description: 'Output frame rate (fps)'
    },
    {
      key: 'ffmpeg_audio_bitrate',
      value: '128',
      description: 'Audio bitrate in kbps'
    },
    {
      key: 'ffmpeg_audio_sample_rate',
      value: '48000',
      description: 'Audio sample rate in Hz'
    },
    {
      key: 'ffmpeg_keyframe_interval',
      value: '60',
      description: 'Keyframe interval (GOP size) in frames'
    },
    {
      key: 'ffmpeg_tune',
      value: 'zerolatency',
      description: 'FFmpeg tune option (film, animation, grain, stillimage, fastdecode, zerolatency)'
    }
  ];

  // Insert settings function
  const insertSetting = db.prepare(`
    INSERT OR IGNORE INTO settings (key, value, description)
    VALUES (?, ?, ?)
  `);

  // Insert quality settings
  let insertedQuality = 0;
  for (const setting of qualitySettings) {
    const result = insertSetting.run(setting.key, setting.value, setting.description);
    if (result.changes > 0) {
      insertedQuality++;
      console.log(`   ✓ Added ${setting.key} = ${setting.value}`);
    } else {
      console.log(`   - Skipped ${setting.key} (already exists)`);
    }
  }

  // Insert encoding settings
  let insertedEncoding = 0;
  for (const setting of encodingSettings) {
    const result = insertSetting.run(setting.key, setting.value, setting.description);
    if (result.changes > 0) {
      insertedEncoding++;
      console.log(`   ✓ Added ${setting.key} = ${setting.value}`);
    } else {
      console.log(`   - Skipped ${setting.key} (already exists)`);
    }
  }

  // Commit transaction
  db.prepare('COMMIT').run();

  console.log('\n✅ Migration completed successfully!');
  console.log(`   - Removed HLS settings`);
  console.log(`   - Added ${insertedQuality} quality preset settings`);
  console.log(`   - Added ${insertedEncoding} encoding parameter settings`);
  console.log(`   - Total new settings: ${insertedQuality + insertedEncoding}`);

} catch (error) {
  // Rollback on error
  db.prepare('ROLLBACK').run();
  console.error('\n❌ Migration failed:', error.message);
  console.error(error.stack);
  process.exit(1);
} finally {
  db.close();
}
