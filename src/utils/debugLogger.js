import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Create logs directory if it doesn't exist
const logsDir = path.join(__dirname, '../../logs');
if (!fs.existsSync(logsDir)) {
  fs.mkdirSync(logsDir, { recursive: true });
}

const debugLogPath = path.join(logsDir, 'webrtc-debug.log');

/**
 * Debug logger for WebRTC zombie connection issues
 * Writes extremely detailed logs to file for troubleshooting
 */
class DebugLogger {
  constructor() {
    this.sessionId = Date.now();
    this.writeLog(`\n\n${'='.repeat(100)}`);
    this.writeLog(`NEW SESSION STARTED: ${new Date().toISOString()} (PID: ${process.pid}, Session: ${this.sessionId})`);
    this.writeLog(`${'='.repeat(100)}\n`);
  }

  writeLog(message) {
    const timestamp = new Date().toISOString();
    const logEntry = `[${timestamp}] [PID:${process.pid}] ${message}\n`;

    try {
      fs.appendFileSync(debugLogPath, logEntry);
    } catch (err) {
      console.error('Failed to write debug log:', err);
    }
  }

  // Log WebRTC session lifecycle
  sessionCreated(channelId, hasExisting) {
    this.writeLog(`SESSION_CREATED: Channel ${channelId} | Existing session: ${hasExisting}`);
  }

  sessionStopped(channelId, reason) {
    this.writeLog(`SESSION_STOPPED: Channel ${channelId} | Reason: ${reason}`);
  }

  // Log peer connection state
  peerConnectionState(channelId, state, details = {}) {
    this.writeLog(`PEER_CONNECTION: Channel ${channelId} | State: ${state} | Details: ${JSON.stringify(details)}`);
  }

  // Log video sink lifecycle
  videoSinkCreated(channelId, trackId) {
    this.writeLog(`VIDEO_SINK_CREATED: Channel ${channelId} | Track: ${trackId}`);
  }

  videoSinkStopped(channelId, method) {
    this.writeLog(`VIDEO_SINK_STOPPED: Channel ${channelId} | Method: ${method}`);
  }

  videoSinkDeleted(channelId) {
    this.writeLog(`VIDEO_SINK_DELETED: Channel ${channelId}`);
  }

  // Log frame processing
  frameReceived(channelId, frameCount, resolution, hasProcess, isProcessRunning) {
    this.writeLog(`FRAME_RECEIVED: Channel ${channelId} | Frame: ${frameCount} | Resolution: ${resolution} | HasProcess: ${hasProcess} | ProcessRunning: ${isProcessRunning}`);
  }

  // Log zombie detection
  zombieDetected(channelId, frameCount, reason) {
    this.writeLog(`🧟 ZOMBIE_DETECTED: Channel ${channelId} | Frame: ${frameCount} | Reason: ${reason}`);
  }

  zombieCleanup(channelId, actions) {
    this.writeLog(`🧟 ZOMBIE_CLEANUP: Channel ${channelId} | Actions: ${JSON.stringify(actions)}`);
  }

  // Log FFmpeg process lifecycle
  ffmpegStarting(channelId, port, streamKey) {
    this.writeLog(`FFMPEG_STARTING: Channel ${channelId} | Port: ${port} | StreamKey: ${streamKey}`);
  }

  ffmpegStarted(channelId, pid) {
    this.writeLog(`FFMPEG_STARTED: Channel ${channelId} | PID: ${pid}`);
  }

  ffmpegStopped(channelId, pid, code, signal) {
    this.writeLog(`FFMPEG_STOPPED: Channel ${channelId} | PID: ${pid} | ExitCode: ${code} | Signal: ${signal}`);
  }

  ffmpegError(channelId, error) {
    this.writeLog(`FFMPEG_ERROR: Channel ${channelId} | Error: ${error}`);
  }

  ffmpegStdinWrite(channelId, success) {
    // Only log every 30th frame to avoid spam
    if (!this._frameWriteCounter) this._frameWriteCounter = {};
    if (!this._frameWriteCounter[channelId]) this._frameWriteCounter[channelId] = 0;
    this._frameWriteCounter[channelId]++;

    if (this._frameWriteCounter[channelId] % 30 === 0) {
      this.writeLog(`FFMPEG_STDIN_WRITE: Channel ${channelId} | Frames written: ${this._frameWriteCounter[channelId]} | LastSuccess: ${success}`);
    }
  }

  // Log platform streaming
  platformStreamingTriggered(channelId, delay) {
    this.writeLog(`PLATFORM_STREAMING_TRIGGERED: Channel ${channelId} | Delay: ${delay}ms`);
  }

  platformStreamingStarted(channelId) {
    this.writeLog(`PLATFORM_STREAMING_STARTED: Channel ${channelId}`);
  }

  platformStreamingFailed(channelId, error) {
    this.writeLog(`PLATFORM_STREAMING_FAILED: Channel ${channelId} | Error: ${error}`);
  }

  // Log port allocation
  portAllocated(channelId, port) {
    this.writeLog(`PORT_ALLOCATED: Channel ${channelId} | Port: ${port}`);
  }

  portReleased(channelId, port) {
    this.writeLog(`PORT_RELEASED: Channel ${channelId} | Port: ${port}`);
  }

  // Log process exit/crash
  processExit(signal, activeChannels) {
    this.writeLog(`❌ PROCESS_EXIT: Signal: ${signal} | Active channels: ${JSON.stringify(activeChannels)}`);
  }

  processCrash(error, stack) {
    this.writeLog(`💥 PROCESS_CRASH: Error: ${error} | Stack: ${stack}`);
  }

  // Log Map state
  mapState(label, channelId = null) {
    const peerConns = Array.from(this.constructor.peerConnections?.keys() || []);
    const ffmpegProcs = Array.from(this.constructor.ffmpegProcesses?.keys() || []);
    const videoSinks = Array.from(this.constructor.videoSinks?.keys() || []);
    const audioSinks = Array.from(this.constructor.audioSinks?.keys() || []);

    this.writeLog(`MAP_STATE[${label}]: ${channelId ? `Channel ${channelId} | ` : ''}PeerConns: [${peerConns}] | FFmpeg: [${ffmpegProcs}] | VideoSinks: [${videoSinks}] | AudioSinks: [${audioSinks}]`);
  }

  // Log memory usage
  memoryUsage() {
    const usage = process.memoryUsage();
    const mb = (bytes) => Math.round(bytes / 1024 / 1024);
    this.writeLog(`MEMORY_USAGE: RSS: ${mb(usage.rss)}MB | Heap: ${mb(usage.heapUsed)}/${mb(usage.heapTotal)}MB | External: ${mb(usage.external)}MB`);
  }

  // Store reference to service maps for inspection
  static setServiceMaps(peerConnections, ffmpegProcesses, videoSinks, audioSinks) {
    this.peerConnections = peerConnections;
    this.ffmpegProcesses = ffmpegProcesses;
    this.videoSinks = videoSinks;
    this.audioSinks = audioSinks;
  }
}

// Create singleton instance
const debugLogger = new DebugLogger();

// Log memory usage every 10 seconds
setInterval(() => {
  debugLogger.memoryUsage();
}, 10000);

// Log process exit
process.on('exit', (code) => {
  debugLogger.writeLog(`PROCESS_EXIT: Code: ${code}`);
});

process.on('SIGTERM', () => {
  debugLogger.processExit('SIGTERM', Array.from(debugLogger.constructor.peerConnections?.keys() || []));
});

process.on('SIGINT', () => {
  debugLogger.processExit('SIGINT', Array.from(debugLogger.constructor.peerConnections?.keys() || []));
});

process.on('uncaughtException', (error) => {
  debugLogger.processCrash(error.message, error.stack);
});

process.on('unhandledRejection', (reason) => {
  debugLogger.processCrash(reason, new Error().stack);
});

export default debugLogger;
