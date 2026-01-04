import Database from 'better-sqlite3';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const dbPath = path.join(__dirname, 'data', 'streaming.db');
const db = new Database(dbPath);

console.log('Seeding predefined RTMP templates...');

const templates = [
  {
    name: 'Twitch (Recommended Settings)',
    platform: 'twitch',
    rtmp_url: 'rtmp://live.twitch.tv/app/',
    stream_key: 'your-twitch-stream-key',
    video_bitrate: '6000k',
    audio_bitrate: '160k',
    profile: 'main',
    preset: 'veryfast',
    fps: 30,
  },
  {
    name: 'Facebook Live (Recommended Settings)',
    platform: 'facebook',
    rtmp_url: 'rtmps://live-api-s.facebook.com:443/rtmp/',
    stream_key: 'your-facebook-stream-key',
    video_bitrate: '4000k',
    audio_bitrate: '128k',
    profile: 'main',
    preset: 'veryfast',
    fps: 30,
  },
  {
    name: 'YouTube Live (Recommended Settings)',
    platform: 'youtube',
    rtmp_url: 'rtmp://a.rtmp.youtube.com/live2/',
    stream_key: 'your-youtube-stream-key',
    video_bitrate: '4500k',
    audio_bitrate: '128k',
    profile: 'high',
    preset: 'veryfast',
    fps: 30,
  },
  {
    name: 'Instagram Live',
    platform: 'custom',
    rtmp_url: 'rtmps://edgetee-upload-hyd1-1.xx.fbcdn.net:443/rtmp/',
    stream_key: 'your-instagram-stream-key',
    video_bitrate: '4000k',
    audio_bitrate: '128k',
    profile: 'main',
    preset: 'veryfast',
    fps: 30,
  },
  {
    name: 'Custom RTMP Server',
    platform: 'custom',
    rtmp_url: 'rtmp://your-server/live',
    stream_key: 'your-stream-key',
    video_bitrate: '4000k',
    audio_bitrate: '128k',
    profile: 'main',
    preset: 'veryfast',
    fps: 30,
  },
];

try {
  // Check if templates already exist
  const existingTemplates = db.prepare('SELECT COUNT(*) as count FROM rtmp_templates').get();

  if (existingTemplates.count > 0) {
    console.log(`⚠️  Found ${existingTemplates.count} existing templates. Skipping seed.`);
    console.log('   To re-seed, delete all templates first or modify this script.');
    db.close();
    process.exit(0);
  }

  const stmt = db.prepare(`
    INSERT INTO rtmp_templates
    (name, platform, rtmp_url, stream_key, video_bitrate, audio_bitrate, profile, preset, fps)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  for (const template of templates) {
    stmt.run(
      template.name,
      template.platform,
      template.rtmp_url,
      template.stream_key,
      template.video_bitrate,
      template.audio_bitrate,
      template.profile,
      template.preset,
      template.fps
    );
    console.log(`✅ Added: ${template.name}`);
  }

  console.log('\n✨ Successfully seeded predefined RTMP templates!');
  console.log('\nTemplates added:');
  templates.forEach(t => {
    console.log(`  - ${t.name} (${t.video_bitrate} video, ${t.audio_bitrate} audio, ${t.fps}fps)`);
  });

  console.log('\n📝 Note: Update the stream keys in Settings → RTMP Templates before using.');

} catch (error) {
  console.error('❌ Seed failed:', error.message);
  process.exit(1);
} finally {
  db.close();
}
