import { spawn } from 'child_process';
import path from 'path';
import fs from 'fs';
import { mkdir, rm, access } from 'fs/promises';
import { createStream } from 'rotating-file-stream';
import Channel from '../models/Channel.js';
import Settings from '../models/Settings.js';
import UserSettings from '../models/UserSettings.js';
import PlatformStream from '../models/PlatformStream.js';
import User from '../models/User.js';
import Plan from '../models/Plan.js';
import logger from '../utils/logger.js';

class StreamManager {
  constructor() {
    // Map of channel ID to process object
    this.processes = new Map();

    // Track reconnection attempts
    this.reconnectAttempts = new Map();

    // Stream health metrics
    this.healthMetrics = new Map();

    // Track manual stops to prevent auto-restart
    this.manualStops = new Set();

    // Track RTMP destination connection status
    // Map<channelId, Map<destinationId, {status: 'connecting'|'connected'|'disconnected', lastUpdate: Date}>>
    this.rtmpConnectionStatus = new Map();

    // Track scheduled cleanup timers to prevent race conditions on restart
    this.cleanupTimers = new Map();

    // Ensure HLS base directory exists (async init)
    this.hlsBasePath = process.env.HLS_BASE_PATH || path.join(process.cwd(), 'var', 'hls');
    this.ensureDirectoriesExist();

    // FFmpeg log directory path
    this.ffmpegLogPath =
      process.env.FFMPEG_LOG_PATH || path.join(process.cwd(), 'logs', 'ffmpeg');

    // FFmpeg executable path
    this.ffmpegPath = process.env.FFMPEG_PATH || 'ffmpeg';

    // Configuration
    this.maxReconnectAttempts = parseInt(process.env.MAX_RECONNECT_ATTEMPTS || '5');
    this.reconnectDelay = parseInt(process.env.RECONNECT_DELAY || '5000');

    logger.info('StreamManager initialized', {
      hlsBasePath: this.hlsBasePath,
      ffmpegLogPath: this.ffmpegLogPath,
      maxReconnectAttempts: this.maxReconnectAttempts,
    });

    // Clean up orphaned stream states on startup
    this.cleanupOrphanedStreams();

    // Start health check interval
    this.startHealthMonitoring();

    // Check FFmpeg version on startup
    this.checkFFmpegVersion();
  }

  // Ensure required directories exist (non-blocking async)
  async ensureDirectoriesExist() {
    try {
      await mkdir(this.hlsBasePath, { recursive: true });
      await mkdir(this.ffmpegLogPath, { recursive: true });
      logger.info('Directories initialized', {
        hlsPath: this.hlsBasePath,
        logPath: this.ffmpegLogPath
      });
    } catch (error) {
      logger.error('Failed to create directories', { error: error.message });
    }
  }

  // Clean up channels marked as running but not actually tracked
  async cleanupOrphanedStreams() {
    try {
      const channels = Channel.findAll();
      let cleanedCount = 0;

      for (const channel of channels) {
        // If channel is marked as running but we don't have it in our process map
        if (channel.status === 'running' && !this.processes.has(channel.id)) {
          logger.warn(`Found orphaned stream state for channel ${channel.id}, marking as stopped`);
          Channel.updateStatus(channel.id, 'stopped');
          cleanedCount++;
        }
      }

      if (cleanedCount > 0) {
        logger.info(`Cleaned up ${cleanedCount} orphaned stream state(s)`);
      }
    } catch (error) {
      logger.error('Failed to cleanup orphaned streams', { error: error.message });
    }
  }

  // Check FFmpeg version on startup
  async checkFFmpegVersion() {
    try {
      const ffmpegVersionProcess = spawn(this.ffmpegPath, ['-version']);

      let versionOutput = '';

      ffmpegVersionProcess.stdout.on('data', (data) => {
        versionOutput += data.toString();
      });

      ffmpegVersionProcess.on('close', (code) => {
        if (code === 0 && versionOutput) {
          // Parse version from output (e.g., "ffmpeg version 4.4.2-0ubuntu0.22.04.1")
          const versionMatch = versionOutput.match(/ffmpeg version ([0-9]+\.[0-9]+\.[0-9]+)/);
          if (versionMatch) {
            const version = versionMatch[1];
            const [major, minor] = version.split('.').map(Number);

            logger.info(`FFmpeg version detected: ${version}`);

            // Check minimum version (FFmpeg 4.3+)
            if (major < 4 || (major === 4 && minor < 3)) {
              logger.warn(`FFmpeg version ${version} is outdated. Recommended: 4.3 or higher. Some features may not work correctly.`);
            }
          } else {
            logger.warn('Could not parse FFmpeg version from output');
          }
        } else {
          logger.error('Failed to check FFmpeg version', { code });
        }
      });

      ffmpegVersionProcess.on('error', (err) => {
        logger.error('Failed to execute FFmpeg version check', { error: err.message });
      });
    } catch (error) {
      logger.error('Error checking FFmpeg version', { error: error.message });
    }
  }

  // Monitor stream health
  startHealthMonitoring() {
    setInterval(() => {
      for (const [channelId, processInfo] of this.processes.entries()) {
        const uptime = Math.floor((Date.now() - processInfo.startTime) / 1000);
        const metrics = this.healthMetrics.get(channelId) || { errors: 0, lastError: null };

        // Update metrics
        this.healthMetrics.set(channelId, {
          ...metrics,
          uptime,
          status: 'healthy',
          lastCheck: new Date().toISOString(),
        });
      }
    }, 30000); // Check every 30 seconds
  }

  // Get platform-specific encoding settings
  // Get resolution from quality preset
  getResolutionFromPreset(preset) {
    const resolutions = {
      '480p': { width: 854, height: 480, bitrate: '2500k' },
      '720p': { width: 1280, height: 720, bitrate: '4000k' },
      '1080p': { width: 1920, height: 1080, bitrate: '6000k' },
    };
    return resolutions[preset] || resolutions['720p'];
  }

  // Sanitize stream key to prevent path traversal attacks
  sanitizeStreamKey(streamKey) {
    // Remove any path separators and parent directory references
    // Only allow alphanumeric characters, hyphens, and underscores
    const sanitized = streamKey.replace(/[^a-zA-Z0-9_-]/g, '');

    // Ensure it's not empty after sanitization
    if (!sanitized || sanitized.length === 0) {
      throw new Error('Invalid stream key: must contain alphanumeric characters');
    }

    // Prevent path traversal attempts
    if (sanitized.includes('..') || sanitized.includes('/') || sanitized.includes('\\')) {
      throw new Error('Invalid stream key: path traversal detected');
    }

    return sanitized;
  }

  getPlatformEncodingSettings(platform, customBitrate = null) {
    const presets = {
      facebook: {
        videoBitrate: '4000k',
        audioBitrate: '128k',
        maxrate: '4500k',
        bufsize: '8000k',
        fps: 30,
        profile: 'main',
        level: '4.1',
      },
      youtube: {
        videoBitrate: '6000k',
        audioBitrate: '128k',
        maxrate: '6500k',
        bufsize: '12000k',
        fps: 30,
        profile: 'high',
        level: '4.2',
      },
      twitch: {
        videoBitrate: '6000k',
        audioBitrate: '160k',
        maxrate: '6000k',
        bufsize: '12000k',
        fps: 30,
        profile: 'main',
        level: '4.1',
      },
      custom: {
        videoBitrate: customBitrate || '4000k',
        audioBitrate: '128k',
        maxrate: customBitrate ? `${parseInt(customBitrate) * 1.1}k` : '4500k',
        bufsize: customBitrate ? `${parseInt(customBitrate) * 2}k` : '8000k',
        fps: 30,
        profile: 'main',
        level: '4.1',
      },
    };

    return presets[platform] || presets.custom;
  }

   // Start a stream for a channel
  async startStream(channelId, user = null) {
    try {
      // Clear manual stop flag when starting a new stream
      this.manualStops.delete(channelId);

      const channel = Channel.findById(channelId);
      if (!channel) {
        throw new Error('Channel not found');
      }

      // Check user plan limits (skip for admins)
      if (user && user.role !== 'admin') {
        const User = (await import('../models/User.js')).default;
        const limits = await User.checkPlanLimits(user.id);

        if (!limits) {
          throw new Error('Failed to check plan limits');
        }

        // Check concurrent stream limit
        if (!limits.canCreate.stream) {
          throw new Error(`Concurrent stream limit reached (${limits.limits.max_concurrent_streams}). Upgrade your plan to stream more.`);
        }

        // Check bitrate limit for channel quality
        const qualityPreset = channel.quality_preset || '720p';
        const bitrateMap = {
          '480p': 2500,
          '720p': 4000,
          '1080p': 6000
        };
        const channelBitrate = bitrateMap[qualityPreset] || 4000;

        if (channelBitrate > limits.limits.max_bitrate) {
          throw new Error(`Quality preset ${qualityPreset} requires ${channelBitrate}k bitrate. Your plan allows up to ${limits.limits.max_bitrate}k. Please lower the quality or upgrade your plan.`);
        }

        // Store stream start time for duration tracking
        this.streamStartTimes = this.streamStartTimes || new Map();
        this.streamStartTimes.set(channelId, Date.now());

        // Set up duration limit timer if plan has max_stream_duration
        if (limits.limits.max_stream_duration) {
          const durationMs = limits.limits.max_stream_duration * 60 * 1000; // Convert minutes to milliseconds

          // Clear any existing timer for this channel
          this.durationTimers = this.durationTimers || new Map();
          if (this.durationTimers.has(channelId)) {
            clearTimeout(this.durationTimers.get(channelId));
          }

          // Set timer to auto-stop stream after duration limit
          const timer = setTimeout(() => {
            logger.warn(`Stream duration limit reached for channel ${channelId}. Auto-stopping stream.`, {
              maxDuration: limits.limits.max_stream_duration,
              user: user.id
            });

            this.stopStream(channelId).catch(err => {
              logger.error(`Failed to auto-stop stream ${channelId} after duration limit:`, err);
            });

            // Update channel with stop reason
            Channel.update(channelId, {
              error_message: `Stream auto-stopped: ${limits.limits.max_stream_duration} minute limit reached (plan: ${limits.user_plan})`
            });
          }, durationMs);

          this.durationTimers.set(channelId, timer);

          logger.info(`Duration limit timer set for channel ${channelId}: ${limits.limits.max_stream_duration} minutes`);
        }

        logger.info(`Plan limits checked for user ${user.id}:`, {
          running: limits.usage.concurrent_streams,
          max: limits.limits.max_concurrent_streams,
          bitrate: channelBitrate,
          maxBitrate: limits.limits.max_bitrate,
          maxDuration: limits.limits.max_stream_duration
        });
      }

      // --- HANDLE INPUT TYPE (YOUTUBE VS VIDEO FILE VS RTMP) ---
      let resolvedInputUrl = channel.input_url;
      const isVideoFile = channel.input_type === 'video';
      const isRtmpInput = channel.input_type === 'rtmp';

      // If input type is RTMP, use nginx-rtmp as input source
      if (isRtmpInput) {
        // RTMP input comes from nginx-rtmp server on localhost
        // Format: rtmp://localhost:1935/live/{stream_key}
        const rtmpInputUrl = `rtmp://localhost:1935/live/${channel.stream_key}`;
        resolvedInputUrl = rtmpInputUrl;
        logger.info(`Using RTMP input for channel ${channelId}: ${rtmpInputUrl}`);
      }
      // If input type is video, get the file path from MediaFile
      else if (isVideoFile) {
        if (!channel.media_file_id) {
          throw new Error('Media file not selected for video input type');
        }

        const MediaFile = (await import('../models/MediaFile.js')).default;
        const mediaFile = MediaFile.findById(channel.media_file_id);

        if (!mediaFile) {
          throw new Error('Selected media file not found');
        }

        if (!fs.existsSync(mediaFile.file_path)) {
          throw new Error(`Media file not found at path: ${mediaFile.file_path}`);
        }

        resolvedInputUrl = mediaFile.file_path;
        logger.info(`Using video file for channel ${channelId}: ${mediaFile.original_name}`);
      } else if (resolvedInputUrl.includes('youtube.com') || resolvedInputUrl.includes('youtu.be')) {
        logger.info(`Resolving YouTube URL for channel ${channelId}`);

        try {
          // Get cookie path from environment variable or use default
          const cookiePath = process.env.YOUTUBE_COOKIES_PATH || '/var/www/live-admin/cookies.txt';

          // Check if cookies file exists
          if (!fs.existsSync(cookiePath)) {
            throw new Error(`Cookies file not found at ${cookiePath}. Please ensure cookies.txt exists.`);
          }

          // Use spawn instead of execSync to avoid signal issues
          const ytdlpPath = process.env.YTDLP_PATH || 'yt-dlp';
          const ytdlpArgs = [
            '--cookies', cookiePath,
            '--user-agent', 'facebookexternalhit/1.1',
            '-g',
            resolvedInputUrl
          ];

          logger.info(`Executing yt-dlp with cookies from ${cookiePath}`);

          // Create promise to handle spawn
          resolvedInputUrl = await new Promise((resolve, reject) => {
            const ytdlp = spawn(ytdlpPath, ytdlpArgs, {
              env: { ...process.env, PATH: `${process.env.PATH}:/usr/local/bin:/root/.deno/bin` }
            });

            let stdout = '';
            let stderr = '';

            ytdlp.stdout.on('data', (data) => {
              stdout += data.toString();
            });

            ytdlp.stderr.on('data', (data) => {
              stderr += data.toString();
            });

            ytdlp.on('close', (code) => {
              if (code === 0 && stdout.trim()) {
                resolve(stdout.trim());
              } else {
                reject(new Error(`yt-dlp exited with code ${code}: ${stderr}`));
              }
            });

            ytdlp.on('error', (err) => {
              reject(new Error(`Failed to spawn yt-dlp: ${err.message}`));
            });

            // Timeout after 90 seconds (increased for slow connections and rate-limited IPs)
            setTimeout(() => {
              ytdlp.kill('SIGTERM');
              reject(new Error('yt-dlp timed out after 90 seconds'));
            }, 90000);
          });

          if (!resolvedInputUrl) {
            throw new Error('yt-dlp returned empty URL');
          }

          logger.info(`Successfully resolved YouTube URL for channel ${channelId}`);
        } catch (err) {
          logger.error(`yt-dlp failed for channel ${channelId}`, { error: err.message });
          throw new Error(`Failed to resolve YouTube URL: ${err.message}`);
        }
      }
      // ----------------------------------------------

      // Check if already running
      if (this.processes.has(channelId)) {
        throw new Error('Stream is already running');
      }

      // Note: Per-user concurrent stream limits are checked above (lines 177-179)
      // No need for global limit - each user has their own plan limits

      // Cancel any pending cleanup for this channel (in case of quick restart)
      if (this.cleanupTimers.has(channelId)) {
        clearTimeout(this.cleanupTimers.get(channelId));
        this.cleanupTimers.delete(channelId);
        logger.info(`Cancelled pending cleanup for channel ${channelId}`);
      }

      // Create channel output directory using sanitized stream_key
      // SECURITY: Sanitize stream_key to prevent path traversal attacks
      const streamKey = channel.stream_key || `channel_${channelId}`;
      const sanitizedStreamKey = this.sanitizeStreamKey(streamKey);
      const outputDir = path.join(this.hlsBasePath, sanitizedStreamKey);
      await mkdir(outputDir, { recursive: true }).catch(err => {
        logger.error(`Failed to create output directory for channel ${channelId}`, { error: err.message });
        throw new Error(`Failed to create output directory: ${err.message}`);
      });

      const outputPath = path.join(outputDir, 'index.m3u8');

      // Get HLS settings
      const hlsSegmentDuration =
        Settings.get('hls_segment_duration')?.value || '4';
      const hlsListSize = Settings.get('hls_list_size')?.value || '10'; // Increased from 6 to 10 for better buffering

      // Get platform streams for this channel
      const platformStreams = PlatformStream.getByChannelId(channelId);

      // Convert platform streams to rtmpDestinations format, respecting enabled state
      const rtmpDestinations = platformStreams
        .filter(stream => stream.enabled === 1 || stream.enabled === true)  // Only include enabled streams
        .map(stream => ({
          id: stream.id,
          platform: stream.platform,
          rtmp_url: stream.rtmp_url,
          stream_key: stream.stream_key,
          enabled: stream.enabled || 1
        }));

      // Initialize RTMP connection status for this channel
      const rtmpStatusMap = new Map();
      rtmpDestinations.forEach(dest => {
        rtmpStatusMap.set(dest.id, {
          status: 'connecting',
          platform: dest.platform,
          lastUpdate: new Date()
        });
        logger.info(`[RTMP-INIT] Added RTMP destination ${dest.platform} (ID: ${dest.id}) to status map for channel ${channelId}`);
      });
      this.rtmpConnectionStatus.set(channelId, rtmpStatusMap);
      logger.info(`[RTMP-INIT] Set rtmpConnectionStatus for channel ${channelId}, map size: ${rtmpStatusMap.size}`);

      // Check watermark availability based on plan
      const channelUser = User.findById(channel.user_id);
      const userPlan = channelUser ? Plan.getById(channelUser.plan_id) : null;
      const hasCustomWatermark = userPlan && userPlan.custom_watermark === 1;

      // Get default watermark settings
      const defaultWatermarkEnabled = Settings.get('default_watermark_enabled')?.value === '1';
      const defaultWatermarkPath = Settings.get('default_watermark_path')?.value;

      // Get user-level watermark settings
      const userWatermarkPath = UserSettings.get(channel.user_id, 'watermark_path')?.value;
      const userWatermarkPosition = UserSettings.get(channel.user_id, 'watermark_position')?.value;
      const userWatermarkOpacity = UserSettings.get(channel.user_id, 'watermark_opacity')?.value;
      const userWatermarkScale = UserSettings.get(channel.user_id, 'watermark_scale')?.value;

      // Determine watermark to use
      let watermarkPath = null;
      let watermarkPosition = 'bottom-right';
      let watermarkOpacity = 0.7;
      let watermarkScale = 0.15;

      if (hasCustomWatermark && channel.watermark_enabled && userWatermarkPath && fs.existsSync(userWatermarkPath)) {
        // User has custom watermark permission, channel has it enabled, and user has uploaded one
        watermarkPath = userWatermarkPath;
        watermarkPosition = userWatermarkPosition || 'top-left';
        watermarkOpacity = parseFloat(userWatermarkOpacity) || 1.0;
        watermarkScale = parseFloat(userWatermarkScale) || 1.0;
        logger.info(`Using user watermark for channel ${channelId}`, { path: watermarkPath });
      } else if (!hasCustomWatermark && defaultWatermarkEnabled && defaultWatermarkPath && fs.existsSync(defaultWatermarkPath)) {
        // Use default watermark ONLY if user doesn't have custom watermark permission
        watermarkPath = defaultWatermarkPath;
        watermarkPosition = Settings.get('default_watermark_position')?.value || 'bottom-right';
        watermarkOpacity = parseFloat(Settings.get('default_watermark_opacity')?.value) || 0.7;
        watermarkScale = parseFloat(Settings.get('default_watermark_scale')?.value) || 0.15;
        logger.info(`Using default watermark for channel ${channelId} (no custom watermark permission)`, { path: watermarkPath });
      } else if (hasCustomWatermark) {
        // User has custom watermark permission but hasn't enabled it - no watermark at all
        logger.info(`No watermark for channel ${channelId} (custom watermark permission, watermark not enabled or not uploaded)`);
      }

      const hasWatermark = watermarkPath !== null;

      // Get quality preset resolution
      const qualityPreset = channel.quality_preset || '720p';
      const resolution = this.getResolutionFromPreset(qualityPreset);

      // Get threading setting from database
      const threadingSetting = Settings.get('ffmpeg_threading');
      let threads;

      if (threadingSetting?.value) {
        if (threadingSetting.value === 'auto') {
          // Dynamic thread allocation based on resolution to prevent CPU hogging
          // SaaS optimization: limit threads per stream to allow multiple concurrent streams
          switch (qualityPreset) {
            case '1080p':
              threads = '2'; // 1080p needs 2 threads
              break;
            case '720p':
              threads = '1'; // 720p uses 1 thread
              break;
            case '480p':
              threads = '1'; // 480p uses 1 thread
              break;
            default:
              threads = '1'; // Default to 1 thread
          }
          logger.info(`Dynamic thread allocation for ${qualityPreset}: ${threads} thread(s)`);
        } else {
          // Use database value
          threads = threadingSetting.value;
          logger.info(`Using database thread setting: ${threads} thread(s)`);
        }
      } else {
        // No database setting, use dynamic allocation as fallback
        switch (qualityPreset) {
          case '1080p':
            threads = '2';
            break;
          case '720p':
            threads = '1';
            break;
          case '480p':
            threads = '1';
            break;
          default:
            threads = '1';
        }
        logger.info(`No database setting found, using dynamic allocation for ${qualityPreset}: ${threads} thread(s)`);
      }

      // Build FFmpeg arguments with improved error handling and quality
      const ffmpegArgs = [
        '-loglevel', 'warning', // Only show warnings and errors
        '-err_detect', 'ignore_err', // Continue on non-critical errors
        '-threads', threads, // Controlled thread count per resolution
      ];

      // Add loop for video files if enabled
      if (isVideoFile && channel.loop_video) {
        ffmpegArgs.push('-stream_loop', '-1'); // -1 means infinite loop
        logger.info(`Auto-loop enabled for channel ${channelId}`);
        Channel.addLog(channelId, 'info', 'Video will loop automatically');
      }

      // Add reconnection settings for live streams (YouTube and RTMP input)
      // Video files don't need reconnection as they're local files
      if (!isVideoFile) {
        ffmpegArgs.push(
          '-reconnect', '1',
          '-reconnect_streamed', '1',
          '-reconnect_delay_max', '5',
          '-timeout', '10000000'
        );
      }

      // For RTMP input, add specific buffer settings to handle incoming stream
      if (isRtmpInput) {
        ffmpegArgs.push(
          '-rtmp_live', 'live'     // Optimize for live streaming
        );
      }

      // Only use -re flag for video files to control playback speed
      // For live streams (YouTube/RTMP), skip -re to allow faster processing
      if (isVideoFile) {
        ffmpegArgs.push('-re'); // Read input at native frame rate for video files
      }

      ffmpegArgs.push(
        '-i',
        resolvedInputUrl
      );

      // Add watermark input if enabled
      // Use -loop 1 for static watermarks to reduce decode overhead
      if (hasWatermark) {
        ffmpegArgs.push('-loop', '1', '-i', watermarkPath);
      }

      // Build filter complex for video processing
      // NO SPLIT needed - Tee muxer handles distribution after encoding

      // Get title overlay settings from user settings (with global defaults)
      const titleEnabled = channel.title_enabled || 0;
      const streamTitle = channel.stream_title || '';
      const userSettings = UserSettings.getAllWithDefaults(channel.user_id);
      const titleBgColor = userSettings.title_bg_color || '#000000';
      const titleOpacity = parseFloat(userSettings.title_opacity || '80') / 100;
      const titlePosition = userSettings.title_position || 'bottom-left';
      const titleTextColor = userSettings.title_text_color || '#FFFFFF';
      const titleFontSize = userSettings.title_font_size || '16';
      const titleBoxPadding = userSettings.title_box_padding || '5';

      if (hasWatermark) {
        const position = this.getWatermarkPosition(watermarkPosition);

        // Build watermark filter - scale, apply watermark
        let watermarkFilter = `[0:v]scale=${resolution.width}:${resolution.height}:force_original_aspect_ratio=decrease,pad=${resolution.width}:${resolution.height}:(ow-iw)/2:(oh-ih)/2[scaled];`;
        watermarkFilter += `[1:v]scale=iw*${watermarkScale}:ih*${watermarkScale},format=rgba,colorchannelmixer=aa=${watermarkOpacity}[logo];`;
        watermarkFilter += `[scaled][logo]overlay=${position}`;

        // Add title overlay if enabled
        if (titleEnabled && streamTitle) {
          const titleDrawtext = this.buildDrawtextFilter(streamTitle, titleBgColor, titleOpacity, titlePosition, titleTextColor, titleFontSize, titleBoxPadding, resolution);
          watermarkFilter += titleDrawtext;
        }

        watermarkFilter += '[vout]';

        ffmpegArgs.push('-filter_complex', watermarkFilter);

        logger.info(`Watermark enabled for channel ${channelId}`, {
          position: watermarkPosition,
          opacity: watermarkOpacity,
          scale: watermarkScale,
          isDefault: watermarkPath === defaultWatermarkPath
        });
        Channel.addLog(channelId, 'info', `Watermark applied at ${watermarkPosition}${watermarkPath === defaultWatermarkPath ? ' (default)' : ''}`);
      } else if (rtmpDestinations.length > 0 || (titleEnabled && streamTitle)) {
        // No watermark but have RTMP destinations or title - scale and optionally add title
        let scaleFilter = `[0:v]scale=${resolution.width}:${resolution.height}:force_original_aspect_ratio=decrease,pad=${resolution.width}:${resolution.height}:(ow-iw)/2:(oh-ih)/2`;

        // Add title overlay if enabled
        if (titleEnabled && streamTitle) {
          const titleDrawtext = this.buildDrawtextFilter(streamTitle, titleBgColor, titleOpacity, titlePosition, titleTextColor, titleFontSize, titleBoxPadding, resolution);
          scaleFilter += titleDrawtext;
        }

        scaleFilter += '[vout]';

        ffmpegArgs.push('-filter_complex', scaleFilter);

        logger.info(`Quality preset ${qualityPreset} (${resolution.width}x${resolution.height}) applied for channel ${channelId}`);
        Channel.addLog(channelId, 'info', `Output quality: ${qualityPreset} (${resolution.width}x${resolution.height})`);
      }

      // Log title overlay if enabled
      if (titleEnabled && streamTitle) {
        logger.info(`Title overlay enabled for channel ${channelId}`, {
          title: streamTitle,
          position: titlePosition,
          fontSize: titleFontSize,
        });
        Channel.addLog(channelId, 'info', `Title overlay: "${streamTitle}" at ${titlePosition}`);
      }

      // OPTIMIZATION: Encode once, use tee muxer to distribute to all outputs
      const needsEncoding = hasWatermark || rtmpDestinations.length > 0 || (titleEnabled && streamTitle);

      if (needsEncoding) {
        // Single encoder for all outputs
        ffmpegArgs.push(
          '-c:v', 'libx264',
          '-preset', 'ultrafast', // Use ultrafast for maximum speed in live streaming
          '-tune', 'zerolatency', // Optimize for low-latency streaming
          '-pix_fmt', 'yuv420p',  // Force YUV 4:2:0 for Twitch/player compatibility
          '-flags', '+global_header', // Ensure SPS/PPS headers work in Tee muxer
          '-g', '60',
          '-keyint_min', '60',
          '-sc_threshold', '0',
          '-b:v', resolution.bitrate,
          '-maxrate', resolution.bitrate,
          '-bufsize', `${parseInt(resolution.bitrate) * 2}k`,
          '-profile:v', 'main',
          '-level', '4.1'
        );
      } else {
        ffmpegArgs.push('-c:v', 'copy');
      }

      // Audio encoding once (AAC for RTMP compatibility)
      // Use 48kHz for better compatibility with Twitch and web players
      ffmpegArgs.push('-c:a', 'aac', '-b:a', '128k', '-ar', '48000');

      // Map once - tee muxer will distribute the encoded stream
      if (needsEncoding) {
        ffmpegArgs.push('-map', '[vout]');
      } else {
        ffmpegArgs.push('-map', '0:v');
      }
      ffmpegArgs.push('-map', '0:a');

      // Use Tee Muxer to send encoded stream to multiple destinations
      if (rtmpDestinations.length > 0) {
        // Build tee outputs
        const teeOutputs = [];

        // Convert Windows paths to forward slashes for FFmpeg
        const safeOutputPath = outputPath.replace(/\\/g, '/');
        const segmentPath = path.join(outputDir, 'segment_%03d.ts').replace(/\\/g, '/');

        // HLS output for tee muxer
        const hlsFlags = [
          `hls_time=${hlsSegmentDuration}`,
          `hls_list_size=${hlsListSize}`,
          `hls_flags=delete_segments+append_list`,
          `hls_segment_filename=${segmentPath}`
        ].join(':');

        teeOutputs.push(`[f=hls:${hlsFlags}]${safeOutputPath}`);

        // Add RTMP outputs
        rtmpDestinations.forEach((dest) => {
          // Construct full RTMP URL, adding / separator if needed
          let rtmpUrl = dest.rtmp_url;
          if (dest.stream_key) {
            // Add separator if rtmp_url doesn't end with / and stream_key doesn't start with /
            const separator = (!rtmpUrl.endsWith('/') && !dest.stream_key.startsWith('/')) ? '/' : '';
            rtmpUrl = `${rtmpUrl}${separator}${dest.stream_key}`;
          }
          // onfail=ignore ensures one RTMP failure doesn't kill the whole stream
          teeOutputs.push(`[f=flv:flvflags=no_duration_filesize:onfail=ignore]${rtmpUrl}`);

          logger.info(`Added ${dest.platform} to tee muxer for channel ${channelId}`);
          Channel.addLog(channelId, 'info', `Streaming to ${dest.platform}`);
        });

        // Add tee muxer
        ffmpegArgs.push(
          '-f', 'tee',
          teeOutputs.join('|')
        );

        logger.info(`Using tee muxer for ${rtmpDestinations.length + 1} outputs (1 HLS + ${rtmpDestinations.length} RTMP)`);
        Channel.addLog(channelId, 'info', `Multi-output: HLS + ${rtmpDestinations.length} RTMP destination(s)`);
      } else {
        // No RTMP destinations, just output to HLS normally
        ffmpegArgs.push(
          '-f', 'hls',
          '-hls_time', hlsSegmentDuration,
          '-hls_list_size', hlsListSize,
          '-hls_flags', 'delete_segments+append_list',
          '-hls_segment_filename', path.join(outputDir, 'segment_%03d.ts'),
          outputPath
        );
      }

      // Create rotating log file for this channel
      // Logs will rotate at 10MB, keep 5 files, and compress old logs
      const logStream = createStream(`channel_${channelId}.log`, {
        size: '10M', // Max 10MB per file
        maxFiles: 5, // Keep 5 rotated files
        path: this.ffmpegLogPath,
        compress: 'gzip' // Compress old logs
      });

      logger.info(`Starting stream for channel ${channelId}`, {
        inputUrl: channel.input_url,
        outputPath,
      });

      // Spawn FFmpeg process
      const ffmpegProcess = spawn(this.ffmpegPath, ffmpegArgs);

      // Store process reference
      this.processes.set(channelId, {
        process: ffmpegProcess,
        logStream,
        startTime: Date.now(),
        errorCount: 0,
        lastError: null,
      });

      // Initialize health metrics
      this.healthMetrics.set(channelId, {
        uptime: 0,
        status: 'starting',
        errors: 0,
        lastError: null,
        lastCheck: new Date().toISOString(),
      });

      // Update channel status
      Channel.updateStatus(channelId, 'running', ffmpegProcess.pid, null);
      Channel.updateOutputPath(channelId, outputPath);
      Channel.addLog(channelId, 'info', 'Stream started successfully');

      // Auto-update RTMP connection status to "connected" after 5 seconds if no errors
      if (rtmpDestinations.length > 0) {
        setTimeout(() => {
          const processStillRunning = this.processes.has(channelId);
          const rtmpStatusMap = this.rtmpConnectionStatus.get(channelId);

          logger.info(`[RTMP-TIMER] 5-second timer fired for channel ${channelId}`, {
            processStillRunning,
            hasRtmpStatusMap: !!rtmpStatusMap,
            rtmpStatusMapSize: rtmpStatusMap ? rtmpStatusMap.size : 0,
            allRtmpChannels: Array.from(this.rtmpConnectionStatus.keys())
          });

          if (processStillRunning && rtmpStatusMap) {
            // Update all RTMP destinations to connected if process is still running
            rtmpDestinations.forEach(dest => {
              const status = rtmpStatusMap.get(dest.id);
              logger.info(`[RTMP-TIMER] Checking dest ${dest.platform} (ID: ${dest.id})`, {
                hasStatus: !!status,
                currentStatus: status?.status
              });
              if (status && status.status === 'connecting') {
                status.status = 'connected';
                status.lastUpdate = new Date();
                logger.info(`RTMP connection established for ${dest.platform} (channel ${channelId})`);
                Channel.addLog(channelId, 'info', `${dest.platform}: Connected`);
              }
            });
          }
        }, 5000); // Wait 5 seconds for stream to stabilize
      }

      // Handle FFmpeg stdout
      ffmpegProcess.stdout.on('data', (data) => {
        const message = data.toString();
        logStream.write(`[STDOUT] ${new Date().toISOString()} - ${message}`);
      });

      // Handle FFmpeg stderr (FFmpeg outputs to stderr)
      ffmpegProcess.stderr.on('data', (data) => {
        const message = data.toString();
        logStream.write(`[STDERR] ${new Date().toISOString()} - ${message}`);

        const processInfo = this.processes.get(channelId);
        const metrics = this.healthMetrics.get(channelId);

        // Detect critical errors
        const criticalErrors = [
          'Connection refused',
          'Connection timed out',
          'HTTP error 403',
          'HTTP error 404',
          'HTTP error 401',
          'Server returned 5XX',
          'Invalid data found',
          'Decoder (codec none) not found',
          'No such file or directory',
          'Conversion failed',
          'Unable to parse option value',
          'Invalid argument',
          'Operation not permitted',
          'Broken pipe',
          'I/O error',
          'Input/output error',
          'av_interleaved_write_frame(): Immediate exit requested',
          'Error opening filters',
          'Cannot allocate memory',
          'Permission denied'
        ];

        const isCriticalError = criticalErrors.some(err => message.includes(err));

        if (isCriticalError) {
          if (processInfo) {
            processInfo.errorCount++;
            processInfo.lastError = message.substring(0, 200);
          }
          if (metrics) {
            metrics.errors++;
            metrics.lastError = message.substring(0, 200);
            metrics.status = 'error';
          }
          Channel.addLog(channelId, 'error', `Critical: ${message.substring(0, 500)}`);
          logger.error(`Critical FFmpeg error for channel ${channelId}`, { error: message.substring(0, 200) });
        } else if (message.toLowerCase().includes('error')) {
          // Non-critical errors
          if (processInfo) {
            processInfo.errorCount++;
          }
          if (metrics) {
            metrics.errors++;
          }
          Channel.addLog(channelId, 'warning', message.substring(0, 500));
        }

        // Detect successful stream start
        if (message.includes('Opening') && message.includes('for writing')) {
          if (metrics) {
            metrics.status = 'healthy';
          }
          logger.info(`Stream established for channel ${channelId}`);
        }

        // Detect RTMP connection status
        const rtmpStatusMap = this.rtmpConnectionStatus.get(channelId);
        if (rtmpStatusMap) {
          // Match patterns like "Opening 'rtmp://..." or "rtmp://... for writing"
          if (message.includes('rtmp://') && (message.includes('Opening') || message.includes('for writing'))) {
            // Extract the RTMP URL to identify which destination
            rtmpDestinations.forEach(dest => {
              const baseUrl = dest.rtmp_url.replace(/\/$/, ''); // Remove trailing slash
              if (message.includes(baseUrl)) {
                const status = rtmpStatusMap.get(dest.id);
                if (status) {
                  status.status = 'connected';
                  status.lastUpdate = new Date();
                  logger.info(`RTMP connection established for ${dest.platform} (channel ${channelId})`);
                  Channel.addLog(channelId, 'info', `${dest.platform}: Connected`);
                }
              }
            });
          }

          // Detect RTMP disconnections or errors
          if ((message.toLowerCase().includes('rtmp') || message.includes('Slave muxer')) &&
              (message.includes('Connection refused') ||
               message.includes('Connection timed out') ||
               message.includes('Failed to update') ||
               message.includes('Server error') ||
               message.includes('Input/output error') ||
               message.includes('error opening') ||
               message.includes('Slave muxer #') && message.includes('failed'))) {
            rtmpDestinations.forEach(dest => {
              const baseUrl = dest.rtmp_url.replace(/\/$/, '');
              if (message.includes(baseUrl) || message.includes(dest.platform)) {
                const status = rtmpStatusMap.get(dest.id);
                if (status) {
                  status.status = 'disconnected';
                  status.lastUpdate = new Date();
                  logger.warn(`RTMP connection failed for ${dest.platform} (channel ${channelId})`);
                  Channel.addLog(channelId, 'warning', `${dest.platform}: Connection failed`);
                }
              }
            });
          }
        }
      });

      // Handle process exit
      ffmpegProcess.on('exit', (code, signal) => {
        logger.info(`FFmpeg process exited for channel ${channelId}`, {
          code,
          signal,
        });

        const processInfo = this.processes.get(channelId);
        if (processInfo) {
          processInfo.logStream.end();
          this.processes.delete(channelId);
        }

        // Clean up health metrics and RTMP connection status
        this.healthMetrics.delete(channelId);
        this.rtmpConnectionStatus.delete(channelId);

        const currentChannel = Channel.findById(channelId);
        if (!currentChannel) return;

        // Check if this was a manual stop
        const wasManualStop = this.manualStops.has(channelId);
        if (wasManualStop) {
          this.manualStops.delete(channelId);
        }

        if (code === 0 || signal === 'SIGTERM' || wasManualStop) {
          // Normal exit or manual stop
          Channel.updateStatus(channelId, 'stopped', null, null);
          if (wasManualStop) {
            Channel.addLog(channelId, 'info', 'Stream stopped by user');
            logger.info(`Stream stopped manually by user for channel ${channelId}`);
          } else if (signal === 'SIGTERM') {
            Channel.addLog(channelId, 'info', 'Stream stopped gracefully');
            logger.info(`Stream terminated gracefully for channel ${channelId}`);
          } else {
            Channel.addLog(channelId, 'info', 'Stream stopped normally');
            logger.info(`Stream exited normally for channel ${channelId}`);
          }
          this.reconnectAttempts.delete(channelId);
        } else {
          // Error exit - determine if we should restart
          const processMetrics = processInfo || {};
          const lastError = processMetrics.lastError || `Exit code ${code}`;

          const errorMsg = `Stream failed: ${lastError}`;
          Channel.updateStatus(channelId, 'error', null, errorMsg);
          Channel.addLog(channelId, 'error', errorMsg);

          // Auto-restart logic with exponential backoff (per-channel setting)
          if (currentChannel.auto_restart) {
            const attempts = this.reconnectAttempts.get(channelId) || 0;

            if (attempts < this.maxReconnectAttempts) {
              this.reconnectAttempts.set(channelId, attempts + 1);

              // Exponential backoff: 5s, 10s, 20s, 40s, 80s
              const delay = this.reconnectDelay * Math.pow(2, attempts);

              logger.info(`Auto-restart attempt ${attempts + 1}/${this.maxReconnectAttempts} for channel ${channelId} in ${delay}ms`);
              Channel.addLog(channelId, 'info', `Restarting in ${delay / 1000}s (attempt ${attempts + 1}/${this.maxReconnectAttempts})`);

              setTimeout(() => {
                this.startStream(channelId).then(() => {
                  // Reset attempts on successful start
                  this.reconnectAttempts.delete(channelId);
                  logger.info(`Stream restarted successfully for channel ${channelId}`);
                  Channel.addLog(channelId, 'info', 'Stream restarted successfully');
                }).catch((err) => {
                  logger.error(`Auto-restart failed for channel ${channelId}`, {
                    error: err.message,
                    attempt: attempts + 1,
                  });
                  Channel.addLog(channelId, 'error', `Restart attempt ${attempts + 1} failed: ${err.message}`);
                });
              }, delay);
            } else {
              logger.error(`Max restart attempts reached for channel ${channelId}`);
              Channel.addLog(channelId, 'error', `Max restart attempts (${this.maxReconnectAttempts}) reached. Manual intervention required.`);
              this.reconnectAttempts.delete(channelId);
            }
          }
        }
      });

      // Handle process errors
      ffmpegProcess.on('error', (error) => {
        logger.error(`FFmpeg process error for channel ${channelId}`, {
          error: error.message,
        });

        const processInfo = this.processes.get(channelId);
        if (processInfo) {
          processInfo.logStream.end();
          this.processes.delete(channelId);
        }

        Channel.updateStatus(channelId, 'error', null, error.message);
        Channel.addLog(channelId, 'error', `Process error: ${error.message}`);
      });

      return {
        success: true,
        message: 'Stream started successfully',
        pid: ffmpegProcess.pid,
      };
    } catch (error) {
      logger.error(`Failed to start stream for channel ${channelId}`, {
        error: error.message,
      });

      Channel.updateStatus(channelId, 'error', null, error.message);
      Channel.addLog(channelId, 'error', `Start failed: ${error.message}`);

      throw error;
    }
  }

  // Stop a stream for a channel
  async stopStream(channelId) {
    try {
      const processInfo = this.processes.get(channelId);

      if (!processInfo) {
        // Update status even if process not found
        Channel.updateStatus(channelId, 'stopped', null, null);
        // Clear reconnect attempts and manual stop flag
        this.reconnectAttempts.delete(channelId);
        this.healthMetrics.delete(channelId);
        this.manualStops.delete(channelId);
        return {
          success: true,
          message: 'Stream was not running',
        };
      }

      logger.info(`Stopping stream for channel ${channelId}`, {
        pid: processInfo.process.pid,
      });

      // Mark as manual stop to prevent auto-restart
      this.manualStops.add(channelId);

      // Clear reconnect attempts
      this.reconnectAttempts.delete(channelId);

      // Clear duration timer if exists
      if (this.durationTimers && this.durationTimers.has(channelId)) {
        clearTimeout(this.durationTimers.get(channelId));
        this.durationTimers.delete(channelId);
        logger.info(`Cleared duration timer for channel ${channelId}`);
      }

      // Clear start time tracking
      if (this.streamStartTimes && this.streamStartTimes.has(channelId)) {
        this.streamStartTimes.delete(channelId);
      }

      // End platform broadcasts before killing FFmpeg
      await this.endPlatformBroadcasts(channelId);

      // Kill the FFmpeg process gracefully
      processInfo.process.kill('SIGTERM');

      // Force kill after 5 seconds if not stopped
      setTimeout(() => {
        if (this.processes.has(channelId)) {
          logger.warn(`Force killing stream for channel ${channelId}`);
          const processInfo = this.processes.get(channelId);
          if (processInfo) {
            processInfo.process.kill('SIGKILL');
          }

          // Forcefully cleanup after SIGKILL to prevent zombie processes
          setTimeout(() => {
            if (this.processes.has(channelId)) {
              logger.error(`Process ${channelId} still exists after SIGKILL, forcing cleanup`);
              this.processes.delete(channelId);
              this.healthMetrics.delete(channelId);
              this.rtmpConnectionStatus.delete(channelId);
              Channel.updateStatus(channelId, 'stopped', null, 'Force stopped - process cleanup');
            }
          }, 2000); // Wait 2 seconds after SIGKILL
        }
      }, 5000);

      // Clean up HLS files after stopping - use longer delay to prevent breaking active viewers
      // HLS files are deleted after 5 minutes to allow:
      // 1. Active viewers to finish watching buffered segments
      // 2. Network delays and player seeking operations
      // 3. New stream starts will overwrite old files anyway
      const cleanupTimer = setTimeout(async () => {
        // Double check stream hasn't restarted
        if (this.processes.has(channelId)) {
          logger.info(`Skipping cleanup for channel ${channelId} - stream restarted`);
          return;
        }

        await this.cleanupChannelAsync(channelId);
        this.cleanupTimers.delete(channelId);
        logger.info(`Cleaned up HLS files for stopped channel ${channelId}`);
      }, 5 * 60 * 1000); // Wait 5 minutes instead of 6 seconds

      // Store the timer so it can be cancelled if stream is restarted quickly
      this.cleanupTimers.set(channelId, cleanupTimer);

      Channel.addLog(channelId, 'info', 'Stream stop requested');

      return {
        success: true,
        message: 'Stream stopped successfully',
      };
    } catch (error) {
      logger.error(`Failed to stop stream for channel ${channelId}`, {
        error: error.message,
      });
      throw error;
    }
  }

  // End platform broadcasts (YouTube, Facebook, Twitch) when stopping stream
  async endPlatformBroadcasts(channelId) {
    try {
      const platformStreams = PlatformStream.getByChannelId(channelId);

      for (const stream of platformStreams) {
        try {
          // Get platform connection to get access tokens
          const PlatformConnection = (await import('../models/PlatformConnection.js')).default;
          const connection = PlatformConnection.getById(stream.platform_connection_id);

          if (!connection || !connection.access_token) {
            logger.warn(`No valid connection found for ${stream.platform} stream ${stream.id}`);
            continue;
          }

          // End broadcast based on platform
          if (stream.platform === 'youtube' && stream.platform_broadcast_id) {
            const YouTubeService = (await import('../services/YouTubeService.js')).default;
            await YouTubeService.endLiveBroadcast(
              connection.access_token,
              connection.refresh_token,
              stream.platform_broadcast_id,
              connection.id
            );
            logger.info(`Ended YouTube broadcast ${stream.platform_broadcast_id} for channel ${channelId}`);
            Channel.addLog(channelId, 'info', 'YouTube broadcast ended');
          } else if (stream.platform === 'facebook' && stream.platform_broadcast_id) {
            const FacebookService = (await import('../services/FacebookService.js')).default;
            await FacebookService.endLiveVideo(
              stream.platform_broadcast_id,
              connection.access_token
            );
            logger.info(`Ended Facebook live video ${stream.platform_broadcast_id} for channel ${channelId}`);
            Channel.addLog(channelId, 'info', 'Facebook live video ended');
          } else if (stream.platform === 'twitch') {
            // Twitch doesn't require explicit stream end - stream automatically goes offline when FFmpeg stops
            logger.info(`Twitch stream for channel ${channelId} will auto-end when FFmpeg stops`);
          } else if (stream.platform === 'custom') {
            // Custom RTMP destinations don't need explicit end calls
            logger.info(`Custom RTMP stream for channel ${channelId} will disconnect when FFmpeg stops`);
          }
        } catch (error) {
          logger.error(`Failed to end ${stream.platform} broadcast for channel ${channelId}`, {
            error: error.message,
            broadcastId: stream.platform_broadcast_id
          });
          // Don't throw - continue stopping other platforms
        }
      }
    } catch (error) {
      logger.error(`Error ending platform broadcasts for channel ${channelId}`, {
        error: error.message
      });
      // Don't throw - stream should still stop even if broadcast end fails
    }
  }

  // Get stream health metrics
  getStreamHealth(channelId) {
    const processInfo = this.processes.get(channelId);
    const metrics = this.healthMetrics.get(channelId);
    const reconnectAttempts = this.reconnectAttempts.get(channelId) || 0;
    const rtmpStatusMap = this.rtmpConnectionStatus.get(channelId);

    logger.info(`[RTMP-GET] getStreamHealth called for channel ${channelId}`, {
      hasProcessInfo: !!processInfo,
      hasRtmpStatusMap: !!rtmpStatusMap,
      rtmpStatusMapSize: rtmpStatusMap ? rtmpStatusMap.size : 0,
      allRtmpChannels: Array.from(this.rtmpConnectionStatus.keys()),
      rtmpStatusMapKeys: rtmpStatusMap ? Array.from(rtmpStatusMap.keys()) : []
    });

    // Convert RTMP status Map to array for API response
    const rtmpConnections = [];
    if (rtmpStatusMap) {
      for (const [destId, status] of rtmpStatusMap.entries()) {
        logger.info(`[RTMP-GET] Found RTMP dest ${status.platform} (ID: ${destId}) with status: ${status.status}`);
        rtmpConnections.push({
          destinationId: destId,
          platform: status.platform,
          status: status.status,
          lastUpdate: status.lastUpdate
        });
      }
    }

    logger.info(`[RTMP-GET] Returning ${rtmpConnections.length} RTMP connections for channel ${channelId}`);

    if (!processInfo) {
      return {
        running: false,
        status: 'stopped',
        rtmpConnections: []
      };
    }

    return {
      running: true,
      pid: processInfo.process.pid,
      uptime: Math.floor((Date.now() - processInfo.startTime) / 1000),
      rtmpConnections,
      errorCount: processInfo.errorCount || 0,
      lastError: processInfo.lastError,
      reconnectAttempts,
      maxReconnectAttempts: this.maxReconnectAttempts,
      status: metrics?.status || 'unknown',
      healthMetrics: metrics,
    };
  }

  // Get watermark position for FFmpeg overlay filter
  getWatermarkPosition(position) {
    const positions = {
      'top-left': '10:10',
      'top-center': '(main_w-overlay_w)/2:10',
      'top-right': 'main_w-overlay_w-10:10',
      'center-left': '10:(main_h-overlay_h)/2',
      'center': '(main_w-overlay_w)/2:(main_h-overlay_h)/2',
      'center-right': 'main_w-overlay_w-10:(main_h-overlay_h)/2',
      'bottom-left': '10:main_h-overlay_h-120',
      'bottom-center': '(main_w-overlay_w)/2:main_h-overlay_h-120',
      'bottom-right': 'main_w-overlay_w-10:main_h-overlay_h-120',
    };
    return positions[position] || positions['top-left'];
  }

  // Build drawtext filter for title overlay with dynamic width and height constraints
  buildDrawtextFilter(text, bgColor, bgOpacity, position, textColor, fontSize, boxPadding = '5', resolution = { width: 1280, height: 720 }) {
    const parsedFontSize = parseInt(fontSize) || 32;
    const padding = 20;
    const parsedBoxPadding = parseInt(boxPadding) || 5;

    // 1. DYNAMIC WIDTH CHECK
    // Estimate char width as ~60% of font size
    const safeWidth = resolution.width - (padding * 2) - (parsedBoxPadding * 2);
    const maxCharsPerLine = Math.floor(safeWidth / (parsedFontSize * 0.6));

    // 2. DYNAMIC HEIGHT CHECK
    // Ensure title doesn't exceed 25% of the total video height
    const maxHeight = resolution.height * 0.25;
    const lineSpacing = parsedFontSize * 1.2; // Including leading/vertical space
    const maxLines = Math.floor(maxHeight / lineSpacing);

    // Wrap text and then truncate if it exceeds max allowed lines
    let lines = this.getWrappedLines(text, maxCharsPerLine);

    if (lines.length > maxLines) {
      lines = lines.slice(0, maxLines);
      // Add ellipsis to the last line to indicate it was cut off
      const lastLine = lines[maxLines - 1];
      lines[maxLines - 1] = lastLine.substring(0, Math.min(lastLine.length, maxCharsPerLine - 3)) + '...';
    }

    const wrappedText = lines.join('\\n');

    // Escape text for FFmpeg (single quotes and colons need escaping)
    const escapedText = wrappedText.replace(/'/g, "'\\''").replace(/:/g, '\\:');

    // Calculate position based on settings
    let x, y;
    const bottomPadding = 70; // Increased padding for bottom positions

    if (position === 'top-left') {
      x = padding;
      y = padding;
    } else if (position === 'top-center') {
      x = '(w-text_w)/2';
      y = padding;
    } else if (position === 'top-right') {
      x = `w-text_w-${padding}`;
      y = padding;
    } else if (position === 'bottom-left') {
      x = padding;
      y = `h-text_h-${bottomPadding}`;
    } else if (position === 'bottom-center') {
      x = '(w-text_w)/2';
      y = `h-text_h-${bottomPadding}`;
    } else if (position === 'bottom-right') {
      x = `w-text_w-${bottomPadding}`;
      y = `h-text_h-${bottomPadding}`;
    } else {
      // Default to bottom-left
      x = padding;
      y = `h-text_h-${bottomPadding}`;
    }

    // OPTIMIZED: Text is pre-wrapped with line breaks (\n) and truncated to max lines
    // Lower box padding = less CPU overhead on each frame
    const drawtextFilter = `,drawtext=text='${escapedText}':fontsize=${parsedFontSize}:fontcolor=${textColor}:x=${x}:y=${y}:box=1:boxcolor=${bgColor}@${bgOpacity}:boxborderw=${parsedBoxPadding}`;

    return drawtextFilter;
  }

  // Helper function to wrap text at word boundaries - returns array of lines
  getWrappedLines(text, maxCharsPerLine) {
    if (text.length <= maxCharsPerLine) {
      return [text];
    }

    const words = text.split(' ');
    const lines = [];
    let currentLine = '';

    for (const word of words) {
      const testLine = currentLine ? `${currentLine} ${word}` : word;

      if (testLine.length <= maxCharsPerLine) {
        currentLine = testLine;
      } else {
        if (currentLine) {
          lines.push(currentLine);
        }
        currentLine = word;
      }
    }

    if (currentLine) {
      lines.push(currentLine);
    }

    return lines;
  }

  // Get stream status (backward compatible, uses health metrics)
  getStreamStatus(channelId) {
    return this.getStreamHealth(channelId);
  }

  // Stop all streams
  async stopAllStreams() {
    logger.info('Stopping all streams');

    const promises = [];
    for (const channelId of this.processes.keys()) {
      promises.push(this.stopStream(channelId));
    }

    await Promise.allSettled(promises);
  }

  // Clean up old HLS files for a channel (async, non-blocking)
  async cleanupChannelAsync(channelId) {
    try {
      // Get channel to retrieve stream_key
      const channel = Channel.findById(channelId);

      // Use sanitized stream_key for cleanup path
      const streamKey = channel?.stream_key || `channel_${channelId}`;
      const sanitizedStreamKey = this.sanitizeStreamKey(streamKey);
      const outputDir = path.join(this.hlsBasePath, sanitizedStreamKey);

      await rm(outputDir, { recursive: true, force: true });
      logger.info(`Cleaned up HLS files for channel ${channelId}`, { streamKey: sanitizedStreamKey });
    } catch (error) {
      // ENOENT errors are fine - directory doesn't exist
      if (error.code !== 'ENOENT') {
        logger.error(`Failed to cleanup channel ${channelId}`, { error: error.message });
      }
    }
  }

  // Clean up old HLS files for a channel (sync, kept for backward compatibility)
  // DEPRECATED: Use cleanupChannelAsync instead
  cleanupChannel(channelId) {
    try {
      // Get channel to retrieve stream_key
      const channel = Channel.findById(channelId);

      // Use sanitized stream_key for cleanup path
      const streamKey = channel?.stream_key || `channel_${channelId}`;
      const sanitizedStreamKey = this.sanitizeStreamKey(streamKey);
      const outputDir = path.join(this.hlsBasePath, sanitizedStreamKey);

      if (fs.existsSync(outputDir)) {
        fs.rmSync(outputDir, { recursive: true, force: true });
        logger.info(`Cleaned up HLS files for channel ${channelId}`, { streamKey: sanitizedStreamKey });
      }
    } catch (error) {
      logger.error(`Failed to cleanup channel ${channelId}`, { error: error.message });
    }
  }
}

// Singleton instance
const streamManager = new StreamManager();

// Graceful shutdown
process.on('SIGTERM', async () => {
  logger.info('SIGTERM received, stopping all streams');
  await streamManager.stopAllStreams();
  process.exit(0);
});

process.on('SIGINT', async () => {
  logger.info('SIGINT received, stopping all streams');
  await streamManager.stopAllStreams();
  process.exit(0);
});

export default streamManager;
