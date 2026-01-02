import { spawn } from 'child_process';
import path from 'path';
import fs from 'fs';
import Channel from '../models/Channel.js';
import Settings from '../models/Settings.js';
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

      // Build FFmpeg arguments
      const ffmpegArgs = [
        '-re', // Read input at native frame rate
        '-i',
        channel.input_url,
        '-c',
        'copy', // Copy codec (no transcoding)
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
        outputPath,
      ];

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
