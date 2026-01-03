import { spawn } from 'child_process';
import path from 'path';
import fs from 'fs';
import Channel from '../models/Channel.js';
import Settings from '../models/Settings.js';
import RtmpDestination from '../models/rtmpDestination.js';
import logger from '../utils/logger.js';

class StreamManager {
  constructor() {
    // Map of channel ID to process object
    this.processes = new Map();

    // Track reconnection attempts
    this.reconnectAttempts = new Map();

    // Stream health metrics
    this.healthMetrics = new Map();

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

    // Start health check interval
    this.startHealthMonitoring();
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
  async startStream(channelId) {
    try {
      const channel = Channel.findById(channelId);
      if (!channel) {
        throw new Error('Channel not found');
      }

      // --- ADD THIS BLOCK TO RESOLVE YOUTUBE URLS ---
      let resolvedInputUrl = channel.input_url;
      
      if (resolvedInputUrl.includes('youtube.com') || resolvedInputUrl.includes('youtu.be')) {
        logger.info(`Resolving YouTube URL for channel ${channelId}`);
        
        const { execSync } = await import('child_process');
        try {
          // Get cookie path from environment variable or use default
          const cookiePath = process.env.YOUTUBE_COOKIES_PATH || '/var/www/live-admin/cookies.txt';

          // Check if cookies file exists
          if (!fs.existsSync(cookiePath)) {
            throw new Error(`Cookies file not found at ${cookiePath}. Please ensure cookies.txt exists.`);
          }

          // Command to get the direct stream URL with cookies
          const ytdlpPath = process.env.YTDLP_PATH || 'yt-dlp';
          const cmd = `${ytdlpPath} --cookies "${cookiePath}" --user-agent "facebookexternalhit/1.1" -g "${resolvedInputUrl}"`;

          logger.info(`Executing yt-dlp with cookies from ${cookiePath}`);

          resolvedInputUrl = execSync(cmd, {
            encoding: 'utf8',
            timeout: 30000, // 30 second timeout
            env: { ...process.env, PATH: `${process.env.PATH}:/usr/local/bin:/root/.deno/bin` }
          }).trim();

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


      // Check max concurrent streams
      const maxStreams = parseInt(
        Settings.get('max_concurrent_streams')?.value || '10'
      );
      if (this.processes.size >= maxStreams) {
        throw new Error(`Maximum concurrent streams (${maxStreams}) reached`);
      }

      // Create channel output directory
      const outputDir = path.join(this.hlsBasePath, `channel_${channelId}`);
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

      // Check if watermark is enabled
      const hasWatermark = channel.watermark_enabled && channel.watermark_path && fs.existsSync(channel.watermark_path);

      // Build FFmpeg arguments with improved error handling and quality
      const ffmpegArgs = [
        '-loglevel', 'warning', // Only show warnings and errors
        '-err_detect', 'ignore_err', // Continue on non-critical errors
        '-reconnect', '1', // Enable reconnection
        '-reconnect_streamed', '1', // Reconnect for streamed protocols
        '-reconnect_delay_max', '5', // Max delay between reconnection attempts
        '-timeout', '10000000', // 10 second timeout for I/O operations
        '-re', // Read input at native frame rate
        '-i',
         resolvedInputUrl,
      ];

      // Add watermark input if enabled
      if (hasWatermark) {
        ffmpegArgs.push('-i', channel.watermark_path);
      }

      // Build filter complex and outputs based on watermark and RTMP destinations
      if (hasWatermark) {
        const position = this.getWatermarkPosition(channel.watermark_position || 'top-left');
        const opacity = channel.watermark_opacity || 1.0;
        const scale = channel.watermark_scale || 1.0;

        // Calculate how many outputs we need (HLS + RTMP destinations)
        const numOutputs = 1 + rtmpDestinations.length;

        // Build watermark filter with split for multiple outputs
        let watermarkFilter = `[1:v]scale=iw*${scale}:ih*${scale},format=rgba,colorchannelmixer=aa=${opacity}[logo];[0:v][logo]overlay=${position}`;

        // If we have multiple outputs, split the watermarked video
        if (numOutputs > 1) {
          watermarkFilter += `[watermarked];[watermarked]split=${numOutputs}`;
          for (let i = 0; i < numOutputs; i++) {
            watermarkFilter += `[v${i}]`;
          }
        } else {
          watermarkFilter += `[v0]`;
        }

        ffmpegArgs.push('-filter_complex', watermarkFilter);

        logger.info(`Watermark enabled for channel ${channelId}`, {
          position: channel.watermark_position,
          opacity: channel.watermark_opacity,
          scale: channel.watermark_scale,
          outputs: numOutputs,
        });
        Channel.addLog(channelId, 'info', `Watermark applied at ${channel.watermark_position}`);
      }

      // Add HLS output
      if (hasWatermark) {
        ffmpegArgs.push(
          '-map', '[v0]', // Use first split output
          '-map', '0:a', // Use original audio
        );
      }

      // Add HLS encoding settings
      ffmpegArgs.push('-c:v', hasWatermark ? 'libx264' : 'copy');
      ffmpegArgs.push('-c:a', 'copy');

      if (hasWatermark) {
        ffmpegArgs.push('-preset', 'veryfast');
        ffmpegArgs.push('-g', '60');
        ffmpegArgs.push('-keyint_min', '60');
        ffmpegArgs.push('-sc_threshold', '0');
      }

      ffmpegArgs.push(
        '-f', 'hls',
        '-hls_time', hlsSegmentDuration,
        '-hls_list_size', hlsListSize,
        '-hls_flags', 'delete_segments+append_list',
        '-hls_segment_filename', path.join(outputDir, 'segment_%03d.ts'),
        outputPath
      );

      // Add RTMP outputs with platform-specific encoding
      if (rtmpDestinations.length > 0) {
        logger.info(`Adding ${rtmpDestinations.length} RTMP destination(s) for channel ${channelId}`);

        for (let i = 0; i < rtmpDestinations.length; i++) {
          const dest = rtmpDestinations[i];
          const rtmpUrl = `${dest.rtmp_url}${dest.stream_key}`;

          // Get platform-specific settings (template settings take priority)
          const encodingSettings = this.getPlatformEncodingSettings(
            dest.platform,
            dest.custom_bitrate
          );

          // Override with template settings if available
          if (dest.template_video_bitrate) {
            encodingSettings.videoBitrate = dest.template_video_bitrate;
            encodingSettings.maxrate = dest.template_video_bitrate;
            encodingSettings.bufsize = `${parseInt(dest.template_video_bitrate) * 2}k`;
          }
          if (dest.template_audio_bitrate) {
            encodingSettings.audioBitrate = dest.template_audio_bitrate;
          }
          if (dest.template_profile) {
            encodingSettings.profile = dest.template_profile;
          }
          if (dest.template_fps) {
            encodingSettings.fps = dest.template_fps;
          }
          const preset = dest.template_preset || 'veryfast';

          // Map video and audio for RTMP output
          if (hasWatermark) {
            // Use the corresponding split output (v1, v2, etc. - v0 is used by HLS)
            ffmpegArgs.push('-map', `[v${i + 1}]`, '-map', '0:a');
          } else {
            ffmpegArgs.push('-map', '0:v', '-map', '0:a');
          }

          // RTMP encoding settings
          ffmpegArgs.push(
            '-c:v', 'libx264',
            '-preset', preset,
            '-b:v', encodingSettings.videoBitrate,
            '-maxrate', encodingSettings.maxrate,
            '-bufsize', encodingSettings.bufsize,
            '-g', '60',
            '-keyint_min', '60',
            '-sc_threshold', '0',
            '-profile:v', encodingSettings.profile,
            '-level', encodingSettings.level,
            '-r', encodingSettings.fps.toString(),
            '-c:a', 'aac',
            '-b:a', encodingSettings.audioBitrate,
            '-f', 'flv',
            rtmpUrl
          );

          logger.info(`Added ${dest.platform} RTMP output for channel ${channelId}`, {
            bitrate: encodingSettings.videoBitrate,
            profile: encodingSettings.profile,
            hasWatermark,
          });
          Channel.addLog(channelId, 'info', `Streaming to ${dest.platform} (${encodingSettings.videoBitrate})`);
        }
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

        // Clean up health metrics
        this.healthMetrics.delete(channelId);

        const currentChannel = Channel.findById(channelId);
        if (!currentChannel) return;

        if (code === 0 || signal === 'SIGTERM') {
          // Normal exit
          Channel.updateStatus(channelId, 'stopped', null, null);
          Channel.addLog(channelId, 'info', 'Stream stopped normally');
          this.reconnectAttempts.delete(channelId);
        } else {
          // Error exit - determine if we should restart
          const processMetrics = processInfo || {};
          const lastError = processMetrics.lastError || `Exit code ${code}`;

          const errorMsg = `Stream failed: ${lastError}`;
          Channel.updateStatus(channelId, 'error', null, errorMsg);
          Channel.addLog(channelId, 'error', errorMsg);

          // Auto-restart logic with exponential backoff
          if (
            currentChannel.auto_restart &&
            Settings.get('auto_restart_enabled')?.value === 'true'
          ) {
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
        // Clear reconnect attempts
        this.reconnectAttempts.delete(channelId);
        this.healthMetrics.delete(channelId);
        return {
          success: true,
          message: 'Stream was not running',
        };
      }

      logger.info(`Stopping stream for channel ${channelId}`, {
        pid: processInfo.process.pid,
      });

      // Clear reconnect attempts to prevent auto-restart
      this.reconnectAttempts.delete(channelId);

      // Kill the FFmpeg process gracefully
      processInfo.process.kill('SIGTERM');

      // Force kill after 5 seconds if not stopped
      setTimeout(() => {
        if (this.processes.has(channelId)) {
          logger.warn(`Force killing stream for channel ${channelId}`);
          processInfo.process.kill('SIGKILL');
        }
      }, 5000);

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

    if (!processInfo) {
      return {
        running: false,
        status: 'stopped',
      };
    }

    return {
      running: true,
      pid: processInfo.process.pid,
      uptime: Math.floor((Date.now() - processInfo.startTime) / 1000),
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
      'bottom-left': '10:main_h-overlay_h-10',
      'bottom-center': '(main_w-overlay_w)/2:main_h-overlay_h-10',
      'bottom-right': 'main_w-overlay_w-10:main_h-overlay_h-10',
    };
    return positions[position] || positions['top-left'];
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
    const outputDir = path.join(this.hlsBasePath, `channel_${channelId}`);

    if (fs.existsSync(outputDir)) {
      fs.rmSync(outputDir, { recursive: true, force: true });
      logger.info(`Cleaned up HLS files for channel ${channelId}`);
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
