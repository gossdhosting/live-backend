import { spawn } from 'child_process';
import path from 'path';
import fs from 'fs';
import Channel from '../models/Channel.js';
import Settings from '../models/Settings.js';
import UserSettings from '../models/UserSettings.js';
import RtmpDestination from '../models/RtmpDestination.js';
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

    // Ensure HLS base directory exists
    this.hlsBasePath = process.env.HLS_BASE_PATH || path.join(process.cwd(), 'var', 'hls');
    if (!fs.existsSync(this.hlsBasePath)) {
      fs.mkdirSync(this.hlsBasePath, { recursive: true });
    }

    // Ensure FFmpeg log directory exists
    this.ffmpegLogPath =
      process.env.FFMPEG_LOG_PATH || path.join(process.cwd(), 'logs', 'ffmpeg');
    if (!fs.existsSync(this.ffmpegLogPath)) {
      fs.mkdirSync(this.ffmpegLogPath, { recursive: true });
    }

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

      // --- HANDLE INPUT TYPE (YOUTUBE VS VIDEO FILE) ---
      let resolvedInputUrl = channel.input_url;
      const isVideoFile = channel.input_type === 'video';

      // If input type is video, get the file path from MediaFile
      if (isVideoFile) {
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

            // Timeout after 45 seconds
            setTimeout(() => {
              ytdlp.kill('SIGTERM');
              reject(new Error('yt-dlp timed out after 45 seconds'));
            }, 45000);
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

      // Create channel output directory using stream_key for isolation
      const streamKey = channel.stream_key || `channel_${channelId}`;
      const outputDir = path.join(this.hlsBasePath, streamKey);
      if (!fs.existsSync(outputDir)) {
        fs.mkdirSync(outputDir, { recursive: true });
      }

      const outputPath = path.join(outputDir, 'index.m3u8');

      // Get HLS settings
      const hlsSegmentDuration =
        Settings.get('hls_segment_duration')?.value || '4';
      const hlsListSize = Settings.get('hls_list_size')?.value || '6';

      // Get enabled RTMP destinations
      const rtmpDestinations = RtmpDestination.getEnabledForChannel(channelId);

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

      // Check if watermark is enabled
      const hasWatermark = channel.watermark_enabled && channel.watermark_path && fs.existsSync(channel.watermark_path);

      // Get quality preset resolution
      const qualityPreset = channel.quality_preset || '720p';
      const resolution = this.getResolutionFromPreset(qualityPreset);

      // Get threading setting from database
      const threadingSetting = Settings.get('ffmpeg_threading');
      const threads = threadingSetting?.value || 'auto'; // Default to auto if not set

      // Build FFmpeg arguments with improved error handling and quality
      const ffmpegArgs = [
        '-loglevel', 'warning', // Only show warnings and errors
        '-err_detect', 'ignore_err', // Continue on non-critical errors
        '-threads', threads === 'auto' ? '0' : threads, // 0 = auto-detect, or specific number
      ];

      // Add loop for video files if enabled
      if (isVideoFile && channel.loop_video) {
        ffmpegArgs.push('-stream_loop', '-1'); // -1 means infinite loop
        logger.info(`Auto-loop enabled for channel ${channelId}`);
        Channel.addLog(channelId, 'info', 'Video will loop automatically');
      }

      // Add reconnection settings only for YouTube/live streams
      if (!isVideoFile) {
        ffmpegArgs.push(
          '-reconnect', '1',
          '-reconnect_streamed', '1',
          '-reconnect_delay_max', '5',
          '-timeout', '10000000'
        );
      }

      ffmpegArgs.push(
        '-re', // Read input at native frame rate
        '-i',
        resolvedInputUrl
      );

      // Add watermark input if enabled
      if (hasWatermark) {
        ffmpegArgs.push('-i', channel.watermark_path);
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
        const position = this.getWatermarkPosition(channel.watermark_position || 'top-left');
        const opacity = channel.watermark_opacity || 1.0;
        const scale = channel.watermark_scale || 1.0;

        // Build watermark filter - scale, apply watermark
        let watermarkFilter = `[0:v]scale=${resolution.width}:${resolution.height}:force_original_aspect_ratio=decrease,pad=${resolution.width}:${resolution.height}:(ow-iw)/2:(oh-ih)/2[scaled];`;
        watermarkFilter += `[1:v]scale=iw*${scale}:ih*${scale},format=rgba,colorchannelmixer=aa=${opacity}[logo];`;
        watermarkFilter += `[scaled][logo]overlay=${position}`;

        // Add title overlay if enabled
        if (titleEnabled && streamTitle) {
          const titleDrawtext = this.buildDrawtextFilter(streamTitle, titleBgColor, titleOpacity, titlePosition, titleTextColor, titleFontSize, titleBoxPadding, resolution);
          watermarkFilter += titleDrawtext;
        }

        watermarkFilter += '[vout]';

        ffmpegArgs.push('-filter_complex', watermarkFilter);

        logger.info(`Watermark enabled for channel ${channelId}`, {
          position: channel.watermark_position,
          opacity: channel.watermark_opacity,
          scale: channel.watermark_scale,
        });
        Channel.addLog(channelId, 'info', `Watermark applied at ${channel.watermark_position}`);
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
          '-preset', 'ultrafast', // Use ultrafast preset for 2-core VPS
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
          const rtmpUrl = `${dest.rtmp_url}${dest.stream_key}`;
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

      // Create log file for this channel
      const logFilePath = path.join(
        this.ffmpegLogPath,
        `channel_${channelId}.log`
      );
      const logStream = fs.createWriteStream(logFilePath, { flags: 'a' });

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

      // Kill the FFmpeg process gracefully
      processInfo.process.kill('SIGTERM');

      // Force kill after 5 seconds if not stopped
      setTimeout(() => {
        if (this.processes.has(channelId)) {
          logger.warn(`Force killing stream for channel ${channelId}`);
          processInfo.process.kill('SIGKILL');
        }
      }, 5000);

      // Clean up HLS files after stopping to prevent stale content
      setTimeout(() => {
        this.cleanupChannel(channelId);
        logger.info(`Cleaned up HLS files for stopped channel ${channelId}`);
      }, 6000); // Wait 6s to ensure FFmpeg has fully stopped

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

  // Clean up old HLS files for a channel
  cleanupChannel(channelId) {
    try {
      const channel = Channel.findById(channelId);
      const streamKey = channel?.stream_key || `channel_${channelId}`;
      const outputDir = path.join(this.hlsBasePath, streamKey);

      if (fs.existsSync(outputDir)) {
        fs.rmSync(outputDir, { recursive: true, force: true });
        logger.info(`Cleaned up HLS files for channel ${channelId}`);
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
