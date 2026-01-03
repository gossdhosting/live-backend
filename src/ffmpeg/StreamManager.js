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

    logger.info('StreamManager initialized', {
      hlsBasePath: this.hlsBasePath,
      ffmpegLogPath: this.ffmpegLogPath,
    });
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

      // Build FFmpeg arguments
      const ffmpegArgs = [
        '-re',
        '-i',
         resolvedInputUrl,
      ];

      // Add watermark input if enabled
      if (hasWatermark) {
        ffmpegArgs.push('-i', channel.watermark_path);
      }

      // Add video filter for watermark
      if (hasWatermark) {
        const position = this.getWatermarkPosition(channel.watermark_position || 'top-left');
        const opacity = channel.watermark_opacity || 1.0;
        const scale = channel.watermark_scale || 1.0;
        ffmpegArgs.push(
          '-filter_complex',
          `[1:v]scale=iw*${scale}:ih*${scale},format=rgba,colorchannelmixer=aa=${opacity}[logo];[0:v][logo]overlay=${position}`,
          '-c:v',
          'libx264', // Need to encode when applying overlay
          '-preset',
          'veryfast', // Fast encoding preset
          '-g',
          '60', // Keyframe interval: 60 frames (2 seconds at 30fps)
          '-keyint_min',
          '60', // Minimum keyframe interval
          '-sc_threshold',
          '0', // Disable scene change detection for consistent keyframes
          '-c:a',
          'copy', // Copy audio codec (no transcoding)
        );
      } else {
        ffmpegArgs.push(
          '-c:v',
          'copy', // Copy video codec (no transcoding)
          '-c:a',
          'copy', // Copy audio codec (no transcoding)
        );
      }

      if (hasWatermark) {
        logger.info(`Watermark enabled for channel ${channelId}`, {
          position: channel.watermark_position,
          opacity: channel.watermark_opacity,
          scale: channel.watermark_scale,
        });
        Channel.addLog(channelId, 'info', `Watermark applied at ${channel.watermark_position}`);
      }

      // Add HLS output
      ffmpegArgs.push(
        '-f',
        'hls', // HLS format
        '-hls_time',
        hlsSegmentDuration,
        '-hls_list_size',
        hlsListSize,
        '-hls_flags',
        'delete_segments+append_list', // Delete old segments
        '-hls_segment_filename',
        path.join(outputDir, 'segment_%03d.ts'),
        outputPath
      );

      // Add RTMP outputs
      if (rtmpDestinations.length > 0) {
        logger.info(`Adding ${rtmpDestinations.length} RTMP destination(s) for channel ${channelId}`);

        for (const dest of rtmpDestinations) {
          const rtmpUrl = `${dest.rtmp_url}${dest.stream_key}`;
          ffmpegArgs.push(
            '-f',
            'flv', // FLV format for RTMP
            '-c:v',
            'copy',
            '-c:a',
            'copy',
            rtmpUrl
          );
          logger.info(`Added ${dest.platform} RTMP output for channel ${channelId}`);
          Channel.addLog(channelId, 'info', `Streaming to ${dest.platform}`);
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

        // Log important messages to database
        if (message.includes('error') || message.includes('Error')) {
          Channel.addLog(channelId, 'error', message.substring(0, 500));
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

        const currentChannel = Channel.findById(channelId);
        if (!currentChannel) return;

        if (code === 0) {
          // Normal exit
          Channel.updateStatus(channelId, 'stopped', null, null);
          Channel.addLog(channelId, 'info', 'Stream stopped normally');
        } else {
          // Error exit
          const errorMsg = `Stream exited with code ${code}`;
          Channel.updateStatus(channelId, 'error', null, errorMsg);
          Channel.addLog(channelId, 'error', errorMsg);

          // Auto-restart if enabled
          if (
            currentChannel.auto_restart &&
            Settings.get('auto_restart_enabled')?.value === 'true'
          ) {
            logger.info(`Auto-restarting stream for channel ${channelId}`);
            setTimeout(() => {
              this.startStream(channelId).catch((err) => {
                logger.error(`Auto-restart failed for channel ${channelId}`, {
                  error: err.message,
                });
              });
            }, 5000); // Wait 5 seconds before restart
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
        return {
          success: true,
          message: 'Stream was not running',
        };
      }

      logger.info(`Stopping stream for channel ${channelId}`, {
        pid: processInfo.process.pid,
      });

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

  // Get stream status
  getStreamStatus(channelId) {
    const processInfo = this.processes.get(channelId);

    if (!processInfo) {
      return {
        running: false,
      };
    }

    return {
      running: true,
      pid: processInfo.process.pid,
      uptime: Math.floor((Date.now() - processInfo.startTime) / 1000),
    };
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
