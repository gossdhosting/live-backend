import { spawn } from 'child_process';
import path from 'path';
import fs from 'fs';
import { mkdir, rm, access } from 'fs/promises';
import { createStream } from 'rotating-file-stream';
import Channel from '../models/Channel.js';
import Settings from '../models/Settings.js';
import UserSettings from '../models/UserSettings.js';
import PlatformStream from '../models/PlatformStream.js';
import RtmpDestination from '../models/RtmpDestination.js';
import User from '../models/User.js';
import Plan from '../models/Plan.js';
import logger from '../utils/logger.js';
import debugLogger from '../utils/debugLogger.js';
import webrtcBridgeService from '../services/WebRTCBridgeService.js';
import portAllocator from '../services/PortAllocator.js';

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

    // Initialize on startup: cleanup orphans and restore auto-restart streams
    this.initializeOnStartup();

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

  // Initialize on startup: cleanup orphaned streams and restore auto-restart streams
  async initializeOnStartup() {
    try {
      // Delay startup to allow database connections to stabilize
      await new Promise(resolve => setTimeout(resolve, 2000));

      const channels = await Channel.findAll();
      const channelsList = Array.isArray(channels) ? channels : [];

      let cleanedCount = 0;
      const streamsToRestart = [];

      for (const channel of channelsList) {
        // If channel is marked as running but we don't have it in our process map
        if (channel.status === 'running' && !this.processes.has(channel.id)) {
          logger.warn(`Found orphaned stream state for channel ${channel.id}, marking as stopped`);
          await Channel.updateStatus(channel.id, 'stopped');
          cleanedCount++;

          // If auto_restart is enabled, queue for restart
          if (channel.auto_restart) {
            streamsToRestart.push(channel);
          }
        }
      }

      if (cleanedCount > 0) {
        logger.info(`Cleaned up ${cleanedCount} orphaned stream state(s)`);
      }

      // Restart streams that had auto_restart enabled
      if (streamsToRestart.length > 0) {
        logger.info(`Found ${streamsToRestart.length} stream(s) with auto_restart enabled, scheduling restart...`);

        // Delay the restart to allow the server to fully initialize
        setTimeout(async () => {
          await this.restoreAutoRestartStreams(streamsToRestart);
        }, 5000); // 5 second delay before starting streams
      }
    } catch (error) {
      logger.error('Failed to initialize on startup', { error: error.message });
    }
  }

  // Restore streams that had auto_restart enabled
  async restoreAutoRestartStreams(channels) {
    logger.info(`Attempting to restore ${channels.length} auto-restart stream(s)...`);

    for (const channel of channels) {
      try {
        logger.info(`Restoring auto-restart stream: ${channel.name} (ID: ${channel.id})`);

        // Start the stream
        await this.startStream(channel.id);

        logger.info(`Successfully restored stream: ${channel.name} (ID: ${channel.id})`);

        // Small delay between starting streams to avoid overwhelming the system
        await new Promise(resolve => setTimeout(resolve, 2000));
      } catch (error) {
        logger.error(`Failed to restore stream ${channel.id}: ${error.message}`);
        // Continue with next stream even if one fails
      }
    }

    logger.info('Auto-restart stream restoration completed');
  }

  // Legacy method for backwards compatibility
  async cleanupOrphanedStreams() {
    return this.initializeOnStartup();
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

  // Validate RTMP connection before starting stream
  // This does a minimal handshake test without sending video data to avoid making platforms go "live"
  async validateRtmpConnection(rtmpUrl, streamKey) {
    return new Promise((resolve, reject) => {
      const fullUrl = streamKey ? `${rtmpUrl}/${streamKey}` : rtmpUrl;

      // Use FFmpeg to test RTMP handshake only - no video/audio data sent
      // By using 'anullsrc' with 0.01 duration and immediately aborting, we only test the connection
      const testArgs = [
        '-v', 'error',
        '-f', 'lavfi',
        '-i', 'anullsrc=r=8000:cl=mono',  // Minimal audio source
        '-f', 'flv',
        '-t', '0.01',  // Extremely short duration
        '-c:a', 'copy',  // No encoding
        '-max_delay', '0',  // No buffering
        '-flags', 'low_delay',  // Low latency mode
        fullUrl
      ];

      const testProcess = spawn(this.ffmpegPath, testArgs);
      let errorOutput = '';
      let hasConnected = false;

      testProcess.stderr.on('data', (data) => {
        const output = data.toString();
        errorOutput += output;

        // Check if connection was successful
        if (output.includes('Stream mapping:') || output.includes('Opening')) {
          hasConnected = true;
        }
      });

      // Very short timeout - just testing handshake
      const timeout = setTimeout(() => {
        // If we've connected by now, consider it successful even if process didn't exit
        if (hasConnected) {
          testProcess.kill('SIGKILL');
          resolve(true);
        } else {
          testProcess.kill('SIGKILL');
          reject(new Error('RTMP connection test timed out - server not responding'));
        }
      }, 5000); // 5 second timeout (reduced from 10)

      testProcess.on('exit', (code) => {
        clearTimeout(timeout);

        // Check for specific connection errors
        if (errorOutput.includes('Connection refused') ||
            errorOutput.includes('Connection timed out') ||
            errorOutput.includes('Server returned 4') ||
            errorOutput.includes('Server returned 5') ||
            errorOutput.includes('Failed to update') ||
            errorOutput.includes('Input/output error') ||
            errorOutput.includes('Invalid data found')) {
          reject(new Error(`RTMP connection failed: ${errorOutput.substring(0, 200)}`));
        } else {
          // Connection successful - handshake completed
          resolve(true);
        }
      });

      testProcess.on('error', (err) => {
        clearTimeout(timeout);
        reject(new Error(`Failed to test RTMP connection: ${err.message}`));
      });
    });
  }

  // Start a stream for a channel
  async startStream(channelId, user = null) {
    debugLogger.writeLog(`🚀 StreamManager.startStream() ENTRY POINT: channelId=${channelId}, user=${user?.id || 'null'}`);
    try {
      debugLogger.writeLog(`🚀 StreamManager.startStream() INSIDE TRY BLOCK: channelId=${channelId}`);
      console.log(`[StreamManager] startStream CALLED for channel ${channelId}`);
      logger.info(`[StreamManager] startStream CALLED for channel ${channelId}`);

      // Clear manual stop flag when starting a new stream
      this.manualStops.delete(channelId);

      const channel = await Channel.findById(channelId);
      debugLogger.writeLog(`🚀 StreamManager.startStream() AFTER Channel.findById: channelId=${channelId}, found=${!!channel}`);
      if (!channel) {
        console.log(`[StreamManager] ERROR: Channel ${channelId} not found`);
        debugLogger.writeLog(`❌ StreamManager.startStream() ERROR: Channel ${channelId} not found`);
        throw new Error('Channel not found');
      }

      debugLogger.writeLog(`🚀 StreamManager.startStream() Channel details: type=${channel.input_type}, status=${channel.status}`);
      console.log(`[StreamManager] Channel ${channelId} found: type=${channel.input_type}, status=${channel.status}`);
      logger.info(`[StreamManager] Channel ${channelId}: type=${channel.input_type}, status=${channel.status}`);

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

      // --- HANDLE INPUT TYPE (YOUTUBE VS VIDEO FILE VS RTMP VS WEBCAM) ---
      let resolvedInputUrl = channel.input_url;
      const isVideoFile = channel.input_type === 'video';
      const isRtmpInput = channel.input_type === 'rtmp';
      const isWebcamInput = channel.input_type === 'webcam';
      const isScreenInput = channel.input_type === 'screen';

      // If input type is RTMP, Webcam, or Screen, use nginx-rtmp as input source
      if (isRtmpInput || isWebcamInput || isScreenInput) {
        debugLogger.writeLog(`🚀 StreamManager.startStream() Input type check: isWebcam=${isWebcamInput}, isScreen=${isScreenInput}, isRtmp=${isRtmpInput}`);
        if (isWebcamInput || isScreenInput) {
          const inputTypeName = isWebcamInput ? 'Webcam' : 'Screen share';
          debugLogger.writeLog(`🚀 StreamManager.startStream() ${inputTypeName} input detected. status=${channel.status}`);
          // Check if webcam/screen is already connected (status = waiting_for_input or running)
          // If it's already waiting or running, this is the platform streaming trigger, NOT the initial setup
          if (channel.status === 'waiting_for_input' || channel.status === 'running') {
            debugLogger.writeLog(`✅ StreamManager.startStream() PLATFORM STREAMING PATH: status=${channel.status}`);
            // WebRTC bridge is already active, frames are flowing
            // Now start actual platform streaming by pulling from nginx-rtmp
            const allocatedPort = portAllocator.getPort(channelId);
            debugLogger.writeLog(`🔌 Port allocated: ${allocatedPort} for channel ${channelId}`);
            if (!allocatedPort) {
              debugLogger.writeLog(`❌ No port allocated for channel ${channelId}`);
              logger.error(`[StreamManager] No RTMP port allocated for ${inputTypeName} channel ${channelId}`);
              throw new Error(`No RTMP port allocated for ${inputTypeName} stream`);
            }

            resolvedInputUrl = `rtmp://127.0.0.1:1935/live/${channel.stream_key}`;
            debugLogger.writeLog(`📡 Resolved input URL: ${resolvedInputUrl}`);
            logger.info(`[StreamManager] Starting platform streaming for ${inputTypeName} channel ${channelId}`);
            logger.info(`[StreamManager] Input: ${resolvedInputUrl} (WebRTC bridge → nginx-rtmp)`);
            console.log(`[StreamManager] Platform streaming triggered for ${inputTypeName} ${channelId}, pulling from ${resolvedInputUrl}`);

            // Continue to platform streaming setup below (don't return early)
          } else {
            const inputTypeName = isWebcamInput ? 'camera' : 'screen share';
            const waitMessage = isWebcamInput ? 'Waiting for camera connection...' : 'Waiting for screen share connection...';
            debugLogger.writeLog(`⏸️ StreamManager.startStream() INITIAL SETUP PATH: status=${channel.status}, returning early`);
            // Initial "Go Live" click - webcam/screen not connected yet
            // Just update status and return early
            await Channel.updateStatus(channelId, 'waiting_for_input', null, waitMessage);
            logger.info(`[StreamManager] ${inputTypeName} stream initiated for channel ${channelId}. Waiting for WebRTC connection...`);
            console.log(`[StreamManager] Channel ${channelId} set to waiting_for_input`);

            // FIX: Add a 60-second watchdog to prevent infinite stuck in waiting_for_input
            // If no connection arrives within 60 seconds, revert to stopped state
            setTimeout(async () => {
              try {
                const freshChannel = await Channel.findById(channelId);
                if (freshChannel && freshChannel.status === 'waiting_for_input') {
                  logger.warn(`[StreamManager] ${inputTypeName} connection timeout for channel ${channelId}. No connection within 60 seconds.`);
                  console.log(`[StreamManager Watchdog] Channel ${channelId} stuck in waiting_for_input. Reverting to stopped.`);
                  await this.stopStream(channelId); // Cleans up and sets status to 'stopped'
                }
              } catch (watchdogError) {
                logger.error(`[StreamManager] Watchdog error for channel ${channelId}:`, { error: watchdogError.message });
              }
            }, 60000); // 60 seconds

            return {
              success: true,
              message: `${inputTypeName} stream waiting for connection. Platform streaming will start automatically.`,
              channelId,
              status: 'waiting_for_input'
            };
          }
        } else {
          // Custom RTMP uses standard port 1935 (external users push here from OBS/vMix)
          resolvedInputUrl = `rtmp://127.0.0.1:1935/live/${channel.stream_key}`;
          logger.info(`Using Custom RTMP input for channel ${channelId}: ${resolvedInputUrl} (external push from OBS/vMix)`);
        }
      }
      // If input type is video, get the file path from MediaFile
      else if (isVideoFile) {
        if (!channel.media_file_id) {
          throw new Error('Media file not selected for video input type');
        }

        const MediaFile = (await import('../models/MediaFile.js')).default;
        const mediaFile = await MediaFile.findById(channel.media_file_id);

        if (!mediaFile) {
          throw new Error('Selected media file not found');
        }

        // Check storage type - S3 files need fresh signed URLs
        if (mediaFile.storage_type === 's3' && mediaFile.s3_key) {
          // Generate fresh signed URL for S3 files (they expire)
          resolvedInputUrl = await MediaFile.getSignedUrl(channel.media_file_id);
          if (!resolvedInputUrl) {
            throw new Error('Failed to generate signed URL for S3 media file');
          }
          logger.info(`Using S3 video file for channel ${channelId}: ${mediaFile.original_name} (generated fresh signed URL)`);
        } else {
          // For local files, check if file exists
          if (!fs.existsSync(mediaFile.file_path)) {
            throw new Error(`Media file not found at path: ${mediaFile.file_path}`);
          }
          resolvedInputUrl = mediaFile.file_path;
          logger.info(`Using local video file for channel ${channelId}: ${mediaFile.original_name}`);
        }
      } else if (resolvedInputUrl && (resolvedInputUrl.includes('youtube.com') || resolvedInputUrl.includes('youtu.be'))) {
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
        const processInfo = this.processes.get(channelId);
        // Verify the process is actually running
        try {
          process.kill(processInfo.process.pid, 0); // Signal 0 checks if process exists
          throw new Error('Stream is already running');
        } catch (e) {
          // Process doesn't exist, clean up
          logger.warn(`Cleaning up stale process entry for channel ${channelId}`);
          this.processes.delete(channelId);
          this.healthMetrics.delete(channelId);
          this.rtmpConnectionStatus.delete(channelId);
        }
      }

      // Note: Per-user concurrent stream limits are checked above (lines 177-179)
      // No need for global limit - each user has their own plan limits

      // Create channel output directory using sanitized stream_key
      // SECURITY: Sanitize stream_key to prevent path traversal attacks
      // No HLS output needed - stream directly to platforms only

      // Get platform streams (OAuth platforms) and RTMP destinations (custom RTMP) for this channel
      const platformStreams = await PlatformStream.getByChannelId(channelId);
      const customRtmpDestinations = await RtmpDestination.getEnabledForChannel(channelId);

      debugLogger.writeLog(`📺 Platform streams found: ${platformStreams?.length || 0} for channel ${channelId}`);

      // Convert platform streams to rtmpDestinations format, respecting enabled state
      const platformRtmpDests = (Array.isArray(platformStreams) ? platformStreams : [])
        .filter(stream => stream.enabled === 1 || stream.enabled === true)  // Only include enabled streams
        .map(stream => ({
          id: `platform_${stream.id}`,  // Prefix to distinguish from custom RTMP
          platform: stream.platform,
          rtmp_url: stream.rtmp_url,
          stream_key: stream.stream_key,
          enabled: stream.enabled || 1
        }));

      // Convert custom RTMP destinations to same format
      const customRtmpDests = (Array.isArray(customRtmpDestinations) ? customRtmpDestinations : [])
        .filter(dest => dest.enabled === 1 || dest.enabled === true)
        .map(dest => ({
          id: `custom_${dest.id}`,  // Prefix to distinguish from platform streams
          platform: dest.platform || 'custom',
          rtmp_url: dest.rtmp_url,
          stream_key: dest.stream_key,
          // FIX: Check dest.video_orientation first, then template, then default
          video_orientation: dest.video_orientation || dest.template_video_orientation || '16:9',
          enabled: dest.enabled || 1
        }));

      // Separate destinations by orientation for split-encode-tee architecture
      // Platform streams (Twitch, YouTube, Facebook) are always 16:9 landscape
      const landscape16x9Destinations = [
        ...platformRtmpDests,
        ...customRtmpDests.filter(d => d.video_orientation === '16:9' || !d.video_orientation)
      ];

      const portrait9x16Destinations = customRtmpDests.filter(d => d.video_orientation === '9:16');

      // Determine if we need split-encode-tee architecture (mixed orientations)
      const hasMixedOrientations = landscape16x9Destinations.length > 0 && portrait9x16Destinations.length > 0;
      const hasOnlyLandscape = landscape16x9Destinations.length > 0 && portrait9x16Destinations.length === 0;
      const hasOnlyPortrait = landscape16x9Destinations.length === 0 && portrait9x16Destinations.length > 0;

      // Combine all destinations for RTMP status tracking
      const rtmpDestinations = [...landscape16x9Destinations, ...portrait9x16Destinations];

      let videoOrientation = '16:9'; // Default
      if (hasMixedOrientations) {
        logger.info(`Channel ${channelId} has mixed orientations - using split-encode-tee architecture`);
        logger.info(`  - Landscape (16:9): ${landscape16x9Destinations.length} destination(s)`);
        logger.info(`  - Portrait (9:16): ${portrait9x16Destinations.length} destination(s)`);
        Channel.addLog(channelId, 'info', `Mixed orientations: ${landscape16x9Destinations.length} landscape + ${portrait9x16Destinations.length} portrait`);
      } else if (hasOnlyPortrait) {
        videoOrientation = '9:16';
        logger.info(`Using portrait orientation (9:16) for channel ${channelId} - all outputs are portrait`);
      }

      // RTMP validation completely disabled
      // Even minimal handshake tests can cause platforms to go "live"
      // Let streams fail naturally if credentials are invalid

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

      // Check watermark availability based on plan (async calls)
      const channelUser = await User.findById(channel.user_id);
      const userPlan = channelUser ? await Plan.getById(channelUser.plan_id) : null;
      // PostgreSQL returns boolean as true/false, SQLite as 1/0
      const hasCustomWatermark = userPlan && (userPlan.custom_watermark === true || userPlan.custom_watermark === 1);

      // Get default watermark settings (for users without custom watermark permission)
      const defaultWatermarkEnabled = Settings.get('default_watermark_enabled')?.value === '1';
      const defaultWatermarkPath = Settings.get('default_watermark_path')?.value;

      // Get user-level watermark settings (watermark file is stored per-user in UserSettings)
      const userWatermarkPathSetting = await UserSettings.get(channel.user_id, 'watermark_path');
      const userWatermarkPositionSetting = await UserSettings.get(channel.user_id, 'watermark_position');
      const userWatermarkOpacitySetting = await UserSettings.get(channel.user_id, 'watermark_opacity');
      const userWatermarkScaleSetting = await UserSettings.get(channel.user_id, 'watermark_scale');

      const userWatermarkPath = userWatermarkPathSetting?.value;
      const userWatermarkPosition = userWatermarkPositionSetting?.value;
      const userWatermarkOpacity = userWatermarkOpacitySetting?.value;
      const userWatermarkScale = userWatermarkScaleSetting?.value;

      // Determine watermark to use
      let watermarkPath = null;
      let watermarkPosition = 'bottom-right';
      let watermarkOpacity = 0.7;
      let watermarkScale = 0.15;

      // Debug logging for watermark decision
      logger.info(`Watermark check for channel ${channelId}:`, {
        hasCustomWatermark,
        channelWatermarkEnabled: channel.watermark_enabled,
        userWatermarkPath,
        userWatermarkPathExists: userWatermarkPath ? fs.existsSync(userWatermarkPath) : false,
        defaultWatermarkEnabled,
        defaultWatermarkPath
      });

      if (hasCustomWatermark && channel.watermark_enabled && userWatermarkPath && fs.existsSync(userWatermarkPath)) {
        // User has custom watermark permission, channel has it enabled, and user has uploaded a watermark
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
      let resolution = this.getResolutionFromPreset(qualityPreset);

      // Apply video orientation - convert to portrait (9:16) if needed
      if (videoOrientation === '9:16') {
        // Swap width and height for portrait orientation
        // Also ensure we use portrait-optimized dimensions (1080x1920 for 9:16)
        resolution = {
          width: 1080,
          height: 1920
        };
        logger.info(`Applied portrait orientation (9:16) for channel ${channelId}: ${resolution.width}x${resolution.height}`);
        Channel.addLog(channelId, 'info', `Portrait mode (9:16): ${resolution.width}x${resolution.height}`);
      }

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
      if (isVideoFile && (channel.loop_video === true || channel.loop_video === 1)) {
        ffmpegArgs.push('-stream_loop', '-1'); // -1 means infinite loop
        logger.info(`Auto-loop enabled for channel ${channelId}`);
        Channel.addLog(channelId, 'info', 'Video will loop automatically');
      }

      // Add reconnection settings for live streams
      // Video files don't need reconnection as they're local files
      // RTMP protocol doesn't support -reconnect/-timeout options (HTTP/HLS only)
      // CRITICAL: -timeout for RTMP implies -rtmp_listen 1 (server mode)
      // Exclude webcam AND screen share (both push to nginx-rtmp via WebRTC bridge)
      if (!isVideoFile && !isRtmpInput && !isWebcamInput && !isScreenInput) {
        ffmpegArgs.push(
          '-reconnect', '1',
          '-reconnect_streamed', '1',
          '-reconnect_delay_max', '5',
          '-timeout', '10000000'
        );
      }

      // For RTMP input, add specific buffer settings to handle incoming stream
      // Following Gemini's recommendations for robust RTMP client configuration
      if (isRtmpInput || isWebcamInput || isScreenInput) {
        ffmpegArgs.push(
          // Force FLV container format for RTMP input (ensures proper format detection)
          '-f', 'flv',
          // Force FFmpeg to act as a client reading a live stream (never server mode)
          '-rtmp_live', 'live',
          // Timeout for socket I/O operations (15 seconds = 15,000,000 microseconds)
          // Allows for brief WebRTC hiccups/transcoding lag without killing the process
          '-rw_timeout', '15000000',
          // Input buffer: Read 3 seconds ahead to smooth out jitter from local ingest
          // This prevents "Input/output error" when there are temporary gaps
          '-rtmp_buffer', '3000'
        );

        if (isWebcamInput) {
          logger.info(`Optimized RTMP client parameters applied for webcam input on channel ${channelId}`);
        }
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
      // Split-Encode-Tee architecture: For mixed orientations, split raw video and encode twice

      // Get title overlay settings from user settings (with global defaults)
      const titleEnabled = channel.title_enabled === true || channel.title_enabled === 1;
      const streamTitle = channel.stream_title || '';
      const userSettings = await UserSettings.getAllWithDefaults(channel.user_id);
      const titleBgColor = userSettings.title_bg_color || '#000000';
      const titleOpacity = parseFloat(userSettings.title_opacity || '80') / 100;
      const titlePosition = userSettings.title_position || 'bottom-left';
      const titleTextColor = userSettings.title_text_color || '#FFFFFF';
      const titleFontSize = userSettings.title_font_size || '16';
      const titleBoxPadding = userSettings.title_box_padding || '5';

      // Define resolutions for both orientations (for mixed orientation case)
      const landscapeResolution = { width: 1280, height: 720, bitrate: '2500k' }; // 16:9
      const portraitResolution = { width: 1080, height: 1920, bitrate: '2500k' }; // 9:16

      if (hasMixedOrientations) {
        // MIXED ORIENTATIONS: Split-Encode-Tee architecture
        // Split raw video into two streams, encode each separately

        let filterComplex = '[0:v]split=2[v_land][v_port];';

        // Landscape chain (16:9)
        filterComplex += `[v_land]scale=${landscapeResolution.width}:${landscapeResolution.height}:force_original_aspect_ratio=decrease,pad=${landscapeResolution.width}:${landscapeResolution.height}:(ow-iw)/2:(oh-ih)/2,setsar=1`;

        if (hasWatermark) {
          const position = this.getWatermarkPosition(watermarkPosition);
          filterComplex += `[scaled_land];[1:v]scale=iw*${watermarkScale}:ih*${watermarkScale},format=rgba,colorchannelmixer=aa=${watermarkOpacity}[logo_land];`;
          filterComplex += `[scaled_land][logo_land]overlay=${position}`;
        }

        if (titleEnabled && streamTitle) {
          const titleDrawtext = this.buildDrawtextFilter(streamTitle, titleBgColor, titleOpacity, titlePosition, titleTextColor, titleFontSize, titleBoxPadding, landscapeResolution);
          filterComplex += titleDrawtext;
        }

        filterComplex += '[out_land];';

        // Portrait chain (9:16)
        filterComplex += `[v_port]scale=${portraitResolution.width}:${portraitResolution.height}:force_original_aspect_ratio=increase,crop=${portraitResolution.width}:${portraitResolution.height},setsar=1`;

        if (hasWatermark) {
          const position = this.getWatermarkPosition(watermarkPosition);
          filterComplex += `[scaled_port];[1:v]scale=iw*${watermarkScale}:ih*${watermarkScale},format=rgba,colorchannelmixer=aa=${watermarkOpacity}[logo_port];`;
          filterComplex += `[scaled_port][logo_port]overlay=${position}`;
        }

        if (titleEnabled && streamTitle) {
          const titleDrawtext = this.buildDrawtextFilter(streamTitle, titleBgColor, titleOpacity, titlePosition, titleTextColor, titleFontSize, titleBoxPadding, portraitResolution);
          filterComplex += titleDrawtext;
        }

        filterComplex += '[out_port]';

        ffmpegArgs.push('-filter_complex', filterComplex);

        logger.info(`Split-encode-tee architecture enabled for channel ${channelId}`, {
          landscapeOutputs: landscape16x9Destinations.length,
          portraitOutputs: portrait9x16Destinations.length
        });
        Channel.addLog(channelId, 'info', `Mixed orientations: ${landscape16x9Destinations.length} landscape + ${portrait9x16Destinations.length} portrait`);

      } else if (hasWatermark) {
        // SINGLE ORIENTATION with watermark
        const position = this.getWatermarkPosition(watermarkPosition);

        let scaleFilter;
        if (videoOrientation === '9:16') {
          scaleFilter = `[0:v]scale=${resolution.width}:${resolution.height}:force_original_aspect_ratio=increase,crop=${resolution.width}:${resolution.height}[scaled];`;
        } else {
          scaleFilter = `[0:v]scale=${resolution.width}:${resolution.height}:force_original_aspect_ratio=decrease,pad=${resolution.width}:${resolution.height}:(ow-iw)/2:(oh-ih)/2[scaled];`;
        }

        let watermarkFilter = scaleFilter;
        watermarkFilter += `[1:v]scale=iw*${watermarkScale}:ih*${watermarkScale},format=rgba,colorchannelmixer=aa=${watermarkOpacity}[logo];`;
        watermarkFilter += `[scaled][logo]overlay=${position}`;

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

      } else if (titleEnabled && streamTitle) {
        // SINGLE ORIENTATION with title only
        let scaleFilter;
        if (videoOrientation === '9:16') {
          scaleFilter = `[0:v]scale=${resolution.width}:${resolution.height}:force_original_aspect_ratio=increase,crop=${resolution.width}:${resolution.height}`;
        } else {
          scaleFilter = `[0:v]scale=${resolution.width}:${resolution.height}:force_original_aspect_ratio=decrease,pad=${resolution.width}:${resolution.height}:(ow-iw)/2:(oh-ih)/2`;
        }

        const titleDrawtext = this.buildDrawtextFilter(streamTitle, titleBgColor, titleOpacity, titlePosition, titleTextColor, titleFontSize, titleBoxPadding, resolution);
        scaleFilter += titleDrawtext;
        scaleFilter += '[vout]';

        ffmpegArgs.push('-filter_complex', scaleFilter);

        logger.info(`Title-only filter with scaling to ${qualityPreset} (${resolution.width}x${resolution.height}) applied for channel ${channelId}`);
        Channel.addLog(channelId, 'info', `Output quality: ${qualityPreset} (${resolution.width}x${resolution.height}) with title overlay`);

      } else if (isWebcamInput || isScreenInput) {
        // WEBRTC STREAM COPY OPTIMIZATION: No filters needed!
        // WebRTC bridge already encoded the stream at proper resolution/bitrate
        // Skip all video filters to enable -c:v copy (no re-encoding)
        logger.info(`WebRTC stream copy optimization enabled for channel ${channelId} - no video filters applied`);
        Channel.addLog(channelId, 'info', `Stream copy mode: Using pre-encoded WebRTC stream (CPU optimized)`);
      } else if (isRtmpInput || isVideoFile) {
        // SINGLE ORIENTATION without watermark/title - scale only (for external RTMP and video files)
        let scaleFilter;
        if (videoOrientation === '9:16') {
          scaleFilter = `[0:v]scale=${resolution.width}:${resolution.height}:force_original_aspect_ratio=increase,crop=${resolution.width}:${resolution.height}[vout]`;
        } else {
          scaleFilter = `[0:v]scale=${resolution.width}:${resolution.height}:force_original_aspect_ratio=decrease,pad=${resolution.width}:${resolution.height}:(ow-iw)/2:(oh-ih)/2[vout]`;
        }

        ffmpegArgs.push('-filter_complex', scaleFilter);

        const inputTypeLabel = isRtmpInput ? 'RTMP input' : 'Video file';
        logger.info(`${inputTypeLabel} scaling to ${qualityPreset} (${resolution.width}x${resolution.height}) for channel ${channelId}`);
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

      // ENCODING DECISION: Encode in these cases:
      // 1. Watermark or title overlay needs to be applied
      // 2. External RTMP input (to control bitrate and keyframe interval for platforms)
      // 3. Video file input (to control bitrate - source files may have higher bitrate than platform limits)
      //
      // OPTIMIZATION: WebRTC streams (webcam/screen) from localhost are already encoded by
      // WebRTCBridgeService with proper bitrate/keyframe settings, so we can use -c:v copy
      // to avoid double encoding. This saves ~40-60% CPU per stream.
      const isExternalRtmpInput = isRtmpInput && !isWebcamInput && !isScreenInput;
      const needsEncoding = hasWatermark || (titleEnabled && streamTitle) || isExternalRtmpInput || isVideoFile;

      // Log encoding decision for debugging
      if (!needsEncoding && (isWebcamInput || isScreenInput)) {
        logger.info(`STREAM COPY OPTIMIZATION: Channel ${channelId} will use -c:v copy (no re-encoding)`, {
          reason: 'WebRTC stream without overlays',
          hasWatermark,
          titleEnabled,
          isWebcamInput,
          isScreenInput,
          cpuSavings: '~40-60%'
        });
        Channel.addLog(channelId, 'info', 'CPU Optimization: Stream copy enabled (no re-encoding needed)');
      } else if (needsEncoding) {
        logger.info(`Encoding required for channel ${channelId}`, {
          hasWatermark,
          titleEnabled: titleEnabled && streamTitle,
          isExternalRtmpInput,
          isVideoFile
        });
      }

      if (hasMixedOrientations) {
        // MIXED ORIENTATIONS: Dual encoding chains with separate tee muxers

        // Landscape encoding chain
        ffmpegArgs.push(
          '-map', '[out_land]',
          '-c:v:0', 'libx264',
          '-preset:v:0', 'ultrafast',
          '-tune:v:0', 'zerolatency',
          '-pix_fmt:v:0', 'yuv420p',
          '-flags:v:0', '+global_header',
          '-g:v:0', '60',
          '-keyint_min:v:0', '60',
          '-sc_threshold:v:0', '0',
          '-b:v:0', landscapeResolution.bitrate,
          '-maxrate:v:0', landscapeResolution.bitrate,
          '-bufsize:v:0', `${parseInt(landscapeResolution.bitrate) * 2}k`,
          '-profile:v:0', 'main',
          '-level:v:0', '4.1'
        );

        // Portrait encoding chain
        ffmpegArgs.push(
          '-map', '[out_port]',
          '-c:v:1', 'libx264',
          '-preset:v:1', 'ultrafast',
          '-tune:v:1', 'zerolatency',
          '-pix_fmt:v:1', 'yuv420p',
          '-flags:v:1', '+global_header',
          '-g:v:1', '60',
          '-keyint_min:v:1', '60',
          '-sc_threshold:v:1', '0',
          '-b:v:1', portraitResolution.bitrate,
          '-maxrate:v:1', portraitResolution.bitrate,
          '-bufsize:v:1', `${parseInt(portraitResolution.bitrate) * 2}k`,
          '-profile:v:1', 'main',
          '-level:v:1', '4.1'
        );

        // Audio encoding (shared by both)
        ffmpegArgs.push('-map', '0:a?', '-c:a', 'aac', '-b:a', '128k', '-ar', '48000');

        // Build separate tee outputs for landscape and portrait
        const landscapeTeeOutputs = [];
        const portraitTeeOutputs = [];

        landscape16x9Destinations.forEach((dest) => {
          let rtmpUrl = dest.rtmp_url;
          // FIX: Only append stream key if it exists and isn't already in the URL
          if (dest.stream_key && !rtmpUrl.includes(dest.stream_key)) {
            const separator = (!rtmpUrl.endsWith('/') && !dest.stream_key.startsWith('/')) ? '/' : '';
            rtmpUrl = `${rtmpUrl}${separator}${dest.stream_key}`;
          }
          landscapeTeeOutputs.push(`[f=flv:flvflags=no_duration_filesize:onfail=ignore:select=\\'v:0,a\\']${rtmpUrl}`);
          logger.info(`Added ${dest.platform} to landscape tee muxer for channel ${channelId}`);
          Channel.addLog(channelId, 'info', `Streaming to ${dest.platform} (landscape 16:9)`);
        });

        portrait9x16Destinations.forEach((dest) => {
          let rtmpUrl = dest.rtmp_url;
          // FIX: Only append stream key if it exists and isn't already in the URL
          if (dest.stream_key && !rtmpUrl.includes(dest.stream_key)) {
            const separator = (!rtmpUrl.endsWith('/') && !dest.stream_key.startsWith('/')) ? '/' : '';
            rtmpUrl = `${rtmpUrl}${separator}${dest.stream_key}`;
          }
          portraitTeeOutputs.push(`[f=flv:flvflags=no_duration_filesize:onfail=ignore:select=\\'v:1,a\\']${rtmpUrl}`);
          logger.info(`Added ${dest.platform} to portrait tee muxer for channel ${channelId}`);
          Channel.addLog(channelId, 'info', `Streaming to ${dest.platform} (portrait 9:16)`);
        });

        // Combine both tee outputs into single tee muxer
        const allTeeOutputs = [...landscapeTeeOutputs, ...portraitTeeOutputs];
        ffmpegArgs.push('-f', 'tee', allTeeOutputs.join('|'));

        logger.info(`Using split-encode-tee with ${landscape16x9Destinations.length} landscape + ${portrait9x16Destinations.length} portrait outputs`);

      } else {
        // SINGLE ORIENTATION: Original single-encode behavior

        if (needsEncoding) {
          // Single encoder for all outputs
          ffmpegArgs.push(
            '-c:v', 'libx264',
            '-preset', 'ultrafast',
            '-tune', 'zerolatency',
            '-pix_fmt', 'yuv420p',
            '-flags', '+global_header',
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

        // Audio handling:
        // - WebRTC streams already have AAC audio from the bridge, use copy
        // - Other sources need AAC encoding for RTMP compatibility
        if (!needsEncoding && (isWebcamInput || isScreenInput)) {
          ffmpegArgs.push('-c:a', 'copy');
          logger.info(`Audio stream copy enabled for WebRTC channel ${channelId}`);
        } else {
          ffmpegArgs.push('-c:a', 'aac', '-b:a', '128k', '-ar', '48000');
        }

        // Map once - tee muxer will distribute the encoded stream
        if (needsEncoding) {
          ffmpegArgs.push('-map', '[vout]');
        } else {
          ffmpegArgs.push('-map', '0:v');
        }
        ffmpegArgs.push('-map', '0:a?');

        // Direct RTMP outputs only (no HLS)
        if (rtmpDestinations.length === 0) {
          throw new Error('No Destination configured for this channel');
        }

        if (rtmpDestinations.length === 1) {
          // Single output - direct RTMP without tee muxer
          const dest = rtmpDestinations[0];
          let rtmpUrl = dest.rtmp_url;
          // FIX: Only append stream key if it exists and isn't already in the URL
          if (dest.stream_key && !rtmpUrl.includes(dest.stream_key)) {
            const separator = (!rtmpUrl.endsWith('/') && !dest.stream_key.startsWith('/')) ? '/' : '';
            rtmpUrl = `${rtmpUrl}${separator}${dest.stream_key}`;
          }

          ffmpegArgs.push(
            '-f', 'flv',
            '-flvflags', 'no_duration_filesize',
            rtmpUrl
          );

          logger.info(`Direct RTMP output to ${dest.platform} for channel ${channelId}`);
          Channel.addLog(channelId, 'info', `Streaming to ${dest.platform}`);
        } else {
          // Multiple outputs - use tee muxer
          const teeOutputs = [];

          rtmpDestinations.forEach((dest) => {
            let rtmpUrl = dest.rtmp_url;
            // FIX: Only append stream key if it exists and isn't already in the URL
            if (dest.stream_key && !rtmpUrl.includes(dest.stream_key)) {
              const separator = (!rtmpUrl.endsWith('/') && !dest.stream_key.startsWith('/')) ? '/' : '';
              rtmpUrl = `${rtmpUrl}${separator}${dest.stream_key}`;
            }
            teeOutputs.push(`[f=flv:flvflags=no_duration_filesize:onfail=ignore]${rtmpUrl}`);

            logger.info(`Added ${dest.platform} to tee muxer for channel ${channelId}`);
            Channel.addLog(channelId, 'info', `Streaming to ${dest.platform}`);
          });

          ffmpegArgs.push(
            '-f', 'tee',
            teeOutputs.join('|')
          );

          logger.info(`Using tee muxer for ${rtmpDestinations.length} RTMP outputs`);
          Channel.addLog(channelId, 'info', `Multi-output: ${rtmpDestinations.length} RTMP destination(s)`);
        }
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
        rtmpDestinations: rtmpDestinations.length,
      });

      // Log the full FFmpeg command for debugging
      const fullCommand = `${this.ffmpegPath} ${ffmpegArgs.join(' ')}`;
      logger.info(`FFmpeg command for channel ${channelId}: ${fullCommand}`);
      logStream.write(`[CMD] ${new Date().toISOString()} - ${fullCommand}\n`);

      debugLogger.writeLog(`🚀 About to spawn FFmpeg process for channel ${channelId}`);
      // Spawn FFmpeg process
      const ffmpegProcess = spawn(this.ffmpegPath, ffmpegArgs);
      debugLogger.writeLog(`✅ FFmpeg process spawned for channel ${channelId}, PID: ${ffmpegProcess.pid}`);

      // Store process reference
      this.processes.set(channelId, {
        process: ffmpegProcess,
        logStream,
        startTime: Date.now(),
        errorCount: 0,
        lastError: null,
      });

      // Initialize health metrics with stream stats
      this.healthMetrics.set(channelId, {
        uptime: 0,
        status: 'starting',
        errors: 0,
        lastError: null,
        lastCheck: new Date().toISOString(),
        // Stream statistics
        quality: qualityPreset, // Use quality preset instead of numeric bitrate
        fps: '30',
        resolution: `${resolution.width}x${resolution.height}`,
      });

      // Update channel status
      Channel.updateStatus(channelId, 'running', ffmpegProcess.pid, null);
      Channel.addLog(channelId, 'info', 'Stream started successfully');

      // Auto-update RTMP connection status after 5 seconds as fallback
      // This handles cases where FFmpeg doesn't output connection messages
      // Only mark as connected if: process still running AND no errors detected
      if (rtmpDestinations.length > 0) {
        setTimeout(() => {
          const processStillRunning = this.processes.has(channelId);
          const rtmpStatusMap = this.rtmpConnectionStatus.get(channelId);
          const processInfo = this.processes.get(channelId);

          logger.info(`[RTMP-TIMER] 5-second timer fired for channel ${channelId}`, {
            processStillRunning,
            hasRtmpStatusMap: !!rtmpStatusMap,
            errorCount: processInfo?.errorCount || 0
          });

          if (processStillRunning && rtmpStatusMap) {
            // Only mark as connected if there were no errors during startup
            const hasErrors = processInfo && processInfo.errorCount > 0;

            rtmpDestinations.forEach(dest => {
              const status = rtmpStatusMap.get(dest.id);
              if (status && status.status === 'connecting') {
                if (!hasErrors) {
                  status.status = 'connected';
                  status.lastUpdate = new Date();
                  logger.info(`RTMP connection assumed connected for ${dest.platform} (channel ${channelId}) - no errors detected`);
                  Channel.addLog(channelId, 'info', `${dest.platform}: Connected`);
                } else {
                  logger.warn(`RTMP connection NOT marked as connected for ${dest.platform} (channel ${channelId}) - errors detected during startup`);
                }
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

          // Extract clean error message without long URLs
          let cleanError = message;

          // If error contains a URL, extract just the platform/error type
          if (message.includes('rtmp://') || message.includes('rtmps://')) {
            // Extract error type (e.g., "Input/output error", "Connection refused")
            const errorTypes = [
              'Input/output error',
              'Connection refused',
              'Connection timed out',
              'Server returned 4',
              'Server returned 5',
              'Failed to update'
            ];

            const foundError = errorTypes.find(e => message.includes(e));

            // Extract platform from URL if possible
            let platform = 'RTMP';
            if (message.includes('twitch.tv')) platform = 'Twitch';
            else if (message.includes('facebook.com') || message.includes('fbcdn.net')) platform = 'Facebook/Instagram';
            else if (message.includes('youtube.com') || message.includes('googlevideo.com')) platform = 'YouTube';

            if (foundError) {
              cleanError = `${platform} connection error: ${foundError}`;
            }
          }

          // Truncate to reasonable length
          cleanError = cleanError.substring(0, 150);

          Channel.addLog(channelId, 'error', cleanError);
          logger.error(`Critical FFmpeg error for channel ${channelId}`, { error: cleanError });
        } else if (message.toLowerCase().includes('error') && !message.includes('Last message repeated')) {
          // Non-critical errors (skip repeated message notices)
          if (processInfo) {
            processInfo.errorCount++;
          }
          if (metrics) {
            metrics.errors++;
          }

          // Clean up error message
          const cleanWarning = message.substring(0, 150);
          Channel.addLog(channelId, 'warning', cleanWarning);
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
          // Match patterns that indicate successful RTMP connection:
          // - "Opening 'rtmp://..." - FFmpeg opening connection
          // - "rtmp://... for writing" - Starting to write
          // - "Writing trailer for" - Successfully writing data
          // FIX: Support RTMPS (secure) and RTMPE (encrypted) protocols
          const isConnecting = (message.includes('rtmp://') || message.includes('rtmps://') || message.includes('rtmpe://')) && (
            message.includes('Opening') ||
            message.includes('for writing') ||
            message.includes('Writing trailer for')
          );

          if (isConnecting) {
            // Extract the RTMP URL to identify which destination
            rtmpDestinations.forEach(dest => {
              // FIX: Normalize URL for comparison by removing trailing slash and protocol
              const cleanDestUrl = dest.rtmp_url.replace(/\/$/, '').replace(/^rtmps?e?:\/\//, '');

              if (message.includes(cleanDestUrl)) {
                const status = rtmpStatusMap.get(dest.id);
                if (status && status.status === 'connecting') {
                  status.status = 'connected';
                  status.lastUpdate = new Date();
                  logger.info(`RTMP connection established for ${dest.platform} via FFmpeg message (channel ${channelId})`);
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

            // Extract error type for cleaner logging
            const errorTypes = [
              'Input/output error',
              'Connection refused',
              'Connection timed out',
              'Server returned 4',
              'Server returned 5',
              'Failed to update'
            ];
            const errorType = errorTypes.find(e => message.includes(e)) || 'Connection error';

            rtmpDestinations.forEach(dest => {
              const baseUrl = dest.rtmp_url.replace(/\/$/, '');
              if (message.includes(baseUrl) || message.includes(dest.platform)) {
                const status = rtmpStatusMap.get(dest.id);
                if (status && status.status !== 'disconnected') { // Only log once
                  status.status = 'disconnected';
                  status.lastUpdate = new Date();
                  logger.warn(`RTMP connection failed for ${dest.platform} (channel ${channelId}): ${errorType}`);
                  Channel.addLog(channelId, 'error', `${dest.platform}: ${errorType}`);
                }
              }
            });
          }
        }
      });

      // Handle process exit
      ffmpegProcess.on('exit', async (code, signal) => {
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

        const currentChannel = await Channel.findById(channelId);
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
          logger.error(`FFmpeg process failed for channel ${channelId}`, {
            code,
            signal,
            lastError,
            errorCount: processMetrics.errorCount || 0
          });
          Channel.addLog(channelId, 'error', `FFmpeg exited with code ${code}: ${lastError}`);
          Channel.updateStatus(channelId, 'error', null, errorMsg);
          Channel.addLog(channelId, 'error', errorMsg);

          // Detect persistent connection errors (RTMP/network issues)
          const isPersistentConnectionError =
            lastError.includes('Input/output error') ||
            lastError.includes('Connection refused') ||
            lastError.includes('Connection timed out') ||
            lastError.includes('Server returned 4') ||
            lastError.includes('Server returned 5') ||
            lastError.includes('Failed to update') ||
            lastError.includes('rtmp://') ||
            lastError.includes('RTMP connection failed');

          // Auto-restart logic with exponential backoff (per-channel setting)
          if (currentChannel.auto_restart) {
            const attempts = this.reconnectAttempts.get(channelId) || 0;

            // If it's a persistent connection error and we've tried 3+ times, disable auto-restart
            if (isPersistentConnectionError && attempts >= 2) {
              logger.error(`Persistent connection error detected for channel ${channelId}, disabling auto-restart`);
              Channel.addLog(channelId, 'error', 'Persistent connection error detected. Auto-restart disabled. Please check RTMP URLs/stream keys and restart manually.');

              // Disable auto-restart in database
              Channel.update(channelId, { auto_restart: 0 }).catch(err => {
                logger.error(`Failed to disable auto_restart for channel ${channelId}`, { error: err.message });
              });

              this.reconnectAttempts.delete(channelId);
              return;
            }

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

      // Stop WebRTC bridge if this is a webcam or screen share input
      const channel = await Channel.findById(channelId);
      if (channel && (channel.input_type === 'webcam' || channel.input_type === 'screen')) {
        try {
          // Pass true to skip platform streaming stop (we're already stopping it here)
          await webrtcBridgeService.stopBridge(channelId, true);
          logger.info(`WebRTC bridge stopped for channel ${channelId}`);
        } catch (error) {
          logger.error(`Failed to stop WebRTC bridge for channel ${channelId}`, { error: error.message });
        }
      }

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

      // End platform broadcasts and prepare custom RTMP for shutdown before killing FFmpeg
      await this.endPlatformBroadcasts(channelId);

      // Give custom RTMP destinations a brief moment to flush buffers after being marked as disconnecting
      // This ensures they receive the status update before FFmpeg terminates
      await new Promise(resolve => setTimeout(resolve, 100));

      // Kill the FFmpeg process gracefully
      processInfo.process.kill('SIGTERM');

      // Reduce grace period to 3 seconds for faster shutdown
      // This minimizes the window where custom RTMP connections are buffering after platform streams end
      setTimeout(() => {
        if (this.processes.has(channelId)) {
          logger.warn(`Force killing stream for channel ${channelId} after grace period`);
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
      }, 3000); // Reduced from 5 seconds to 3 seconds

      // HLS cleanup timer removed - no HLS files are generated anymore

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

  // End platform broadcasts (YouTube, Facebook, Twitch) and custom RTMP when stopping stream
  async endPlatformBroadcasts(channelId) {
    try {
      // Handle platform streams (YouTube, Facebook, Twitch)
      const platformStreams = await PlatformStream.getByChannelId(channelId);

      for (const stream of (Array.isArray(platformStreams) ? platformStreams : [])) {
        try {
          // Get platform connection to get access tokens
          const PlatformConnection = (await import('../models/PlatformConnection.js')).default;
          const connection = await PlatformConnection.getById(stream.platform_connection_id);

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
          }
        } catch (error) {
          logger.error(`Failed to end ${stream.platform} broadcast for channel ${channelId}`, {
            error: error.message,
            broadcastId: stream.platform_broadcast_id
          });
          // Don't throw - continue stopping other platforms
        }
      }

      // Custom RTMP destinations will disconnect automatically when FFmpeg process terminates
      // No need to send explicit disconnect signals - they can cause issues
      logger.info(`Custom RTMP destinations will disconnect automatically when FFmpeg terminates for channel ${channelId}`);
    } catch (error) {
      logger.error(`Error ending platform broadcasts for channel ${channelId}`, {
        error: error.message
      });
      // Don't throw - stream should still stop even if broadcast end fails
    }
  }

  // Get stream health metrics
  async getStreamHealth(channelId) {
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
      // Check if stream is running according to database (may have lost track after restart)
      const channel = await Channel.findById(channelId);

      if (channel && channel.status === 'running' && channel.process_id) {
        // Stream is running but we lost track of it - provide basic healthMetrics
        const qualityPreset = channel.quality_preset || '720p';
        const resolution = this.getResolutionFromPreset(qualityPreset);

        return {
          running: true,
          pid: channel.process_id,
          uptime: null, // Unknown since we don't have startTime
          rtmpConnections,
          errorCount: 0,
          lastError: null,
          reconnectAttempts: 0,
          maxReconnectAttempts: this.maxReconnectAttempts,
          status: 'running',
          healthMetrics: {
            uptime: null,
            status: 'running',
            errors: 0,
            lastError: null,
            lastCheck: new Date().toISOString(),
            quality: qualityPreset, // Use quality preset instead of numeric bitrate
            fps: '30',
            resolution: `${resolution.width}x${resolution.height}`,
          },
        };
      }

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
  async getStreamStatus(channelId) {
    return await this.getStreamHealth(channelId);
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

  // HLS cleanup removed - no HLS files are generated anymore
  async cleanupChannelAsync(channelId) {
    // No-op: HLS has been removed from the system
    logger.info(`Cleanup called for channel ${channelId} - no action needed (HLS removed)`);
  }

  // HLS cleanup removed - no HLS files are generated anymore
  cleanupChannel(channelId) {
    // No-op: HLS has been removed from the system
    logger.info(`Cleanup called for channel ${channelId} - no action needed (HLS removed)`);
  }
}

// Singleton instance
const streamManager = new StreamManager();

// Graceful shutdown
process.on('SIGTERM', async () => {
  logger.info('SIGTERM received, stopping all streams and WebRTC bridges');
  await streamManager.stopAllStreams();
  await webrtcBridgeService.cleanup();
  process.exit(0);
});

process.on('SIGINT', async () => {
  logger.info('SIGINT received, stopping all streams and WebRTC bridges');
  await streamManager.stopAllStreams();
  await webrtcBridgeService.cleanup();
  process.exit(0);
});

export default streamManager;
