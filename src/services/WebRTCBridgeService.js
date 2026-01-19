import { spawn } from 'child_process';
import { RTCPeerConnection, RTCSessionDescription, RTCIceCandidate, nonstandard } from 'wrtc';
import logger from '../utils/logger.js';
import Channel from '../models/Channel.js';

const { RTCAudioSink, RTCVideoSink } = nonstandard;

/**
 * WebRTC Bridge Service
 * Converts WebRTC camera streams to RTMP for ingestion into nginx-rtmp server
 */
class WebRTCBridgeService {
  constructor() {
    // Store active peer connections and FFmpeg processes
    this.peerConnections = new Map(); // channelId -> RTCPeerConnection
    this.ffmpegProcesses = new Map(); // channelId -> FFmpeg process
    this.videoSinks = new Map(); // channelId -> RTCVideoSink
    this.audioSinks = new Map(); // channelId -> RTCAudioSink
    this.streamStates = new Map(); // channelId -> { status, startTime, errors }
  }

  /**
   * Create WebRTC peer connection for a channel
   */
  async createPeerConnection(channelId, streamKey) {
    try {
      // Validate channel exists
      const channel = await Channel.findById(channelId);
      if (!channel) {
        throw new Error('Channel not found');
      }

      if (channel.input_type !== 'webcam') {
        throw new Error('Channel input type must be webcam');
      }

      // Check if connection already exists
      if (this.peerConnections.has(channelId)) {
        logger.warn(`WebRTC connection already exists for channel ${channelId}`);
        return this.peerConnections.get(channelId);
      }

      // Create peer connection with STUN server
      const peerConnection = new RTCPeerConnection({
        iceServers: [
          { urls: 'stun:stun.l.google.com:19302' },
          { urls: 'stun:stun1.l.google.com:19302' }
        ]
      });

      // Handle incoming tracks (video and audio)
      peerConnection.ontrack = (event) => {
        const track = event.track;
        logger.info(`WebRTC track received for channel ${channelId}: ${track.kind}`);

        if (track.kind === 'video') {
          this.handleVideoTrack(channelId, track, streamKey);
        } else if (track.kind === 'audio') {
          this.handleAudioTrack(channelId, track, streamKey);
        }
      };

      // Handle connection state changes
      peerConnection.onconnectionstatechange = () => {
        logger.info(`WebRTC connection state for channel ${channelId}: ${peerConnection.connectionState}`);

        if (peerConnection.connectionState === 'connected') {
          this.updateStreamState(channelId, { status: 'connected', startTime: Date.now() });
        } else if (peerConnection.connectionState === 'disconnected' || peerConnection.connectionState === 'failed') {
          this.updateStreamState(channelId, { status: 'disconnected' });
          this.stopBridge(channelId);
        }
      };

      // Handle ICE connection state
      peerConnection.oniceconnectionstatechange = () => {
        logger.info(`ICE connection state for channel ${channelId}: ${peerConnection.iceConnectionState}`);
      };

      // Store peer connection
      this.peerConnections.set(channelId, peerConnection);

      // Initialize stream state
      this.streamStates.set(channelId, {
        status: 'initializing',
        startTime: null,
        errors: 0,
        streamKey
      });

      logger.info(`WebRTC peer connection created for channel ${channelId}`);
      return peerConnection;

    } catch (error) {
      logger.error(`Failed to create peer connection for channel ${channelId}`, { error: error.message });
      throw error;
    }
  }

  /**
   * Handle incoming video track
   */
  handleVideoTrack(channelId, track, streamKey) {
    try {
      const videoSink = new RTCVideoSink(track);
      this.videoSinks.set(channelId, videoSink);

      let frameCount = 0;
      videoSink.onframe = ({ frame }) => {
        frameCount++;

        // Start FFmpeg bridge on first frame
        if (frameCount === 1) {
          this.startFFmpegBridge(channelId, streamKey, frame);
        }

        // Write frame to FFmpeg stdin
        const ffmpegProcess = this.ffmpegProcesses.get(channelId);
        if (ffmpegProcess && ffmpegProcess.stdin && !ffmpegProcess.stdin.destroyed) {
          const yuv = this.convertToYUV420(frame);
          try {
            ffmpegProcess.stdin.write(yuv);
          } catch (err) {
            logger.error(`Failed to write video frame for channel ${channelId}`, { error: err.message });
          }
        }
      };

      logger.info(`Video track handler attached for channel ${channelId}`);
    } catch (error) {
      logger.error(`Failed to handle video track for channel ${channelId}`, { error: error.message });
    }
  }

  /**
   * Handle incoming audio track
   */
  handleAudioTrack(channelId, track, streamKey) {
    try {
      const audioSink = new RTCAudioSink(track);
      this.audioSinks.set(channelId, audioSink);

      audioSink.ondata = ({ samples }) => {
        // Write audio samples to FFmpeg
        const ffmpegProcess = this.ffmpegProcesses.get(channelId);
        if (ffmpegProcess && ffmpegProcess.audioStdin && !ffmpegProcess.audioStdin.destroyed) {
          try {
            // Convert samples to buffer
            const buffer = Buffer.from(samples.buffer);
            ffmpegProcess.audioStdin.write(buffer);
          } catch (err) {
            logger.error(`Failed to write audio samples for channel ${channelId}`, { error: err.message });
          }
        }
      };

      logger.info(`Audio track handler attached for channel ${channelId}`);
    } catch (error) {
      logger.error(`Failed to handle audio track for channel ${channelId}`, { error: error.message });
    }
  }

  /**
   * Convert WebRTC frame to YUV420 format for FFmpeg
   */
  convertToYUV420(frame) {
    const width = frame.width;
    const height = frame.height;
    const ySize = width * height;
    const uvSize = (width / 2) * (height / 2);

    // Create YUV buffer
    const yuv = Buffer.alloc(ySize + uvSize * 2);

    // Copy Y, U, V planes from frame data
    frame.data.copy(yuv, 0, 0, ySize); // Y plane
    frame.data.copy(yuv, ySize, ySize, ySize + uvSize); // U plane
    frame.data.copy(yuv, ySize + uvSize, ySize + uvSize, ySize + uvSize * 2); // V plane

    return yuv;
  }

  /**
   * Start FFmpeg bridge to convert WebRTC stream to RTMP
   */
  startFFmpegBridge(channelId, streamKey, firstFrame) {
    try {
      // Check if already running
      if (this.ffmpegProcesses.has(channelId)) {
        logger.warn(`FFmpeg bridge already running for channel ${channelId}`);
        return;
      }

      const width = firstFrame.width;
      const height = firstFrame.height;
      const rtmpUrl = `rtmp://127.0.0.1:1935/live/${streamKey}`;

      logger.info(`Starting FFmpeg bridge for channel ${channelId}: ${width}x${height} -> ${rtmpUrl}`);

      // FFmpeg command to convert raw video/audio to RTMP
      const ffmpegArgs = [
        '-loglevel', 'warning',
        '-threads', '2',

        // Video input (raw YUV420 from WebRTC)
        '-f', 'rawvideo',
        '-pixel_format', 'yuv420p',
        '-video_size', `${width}x${height}`,
        '-framerate', '30',
        '-i', 'pipe:0',

        // Audio input (raw PCM from WebRTC)
        '-f', 's16le',
        '-ar', '48000',
        '-ac', '2',
        '-i', 'pipe:1',

        // Video encoding
        '-c:v', 'libx264',
        '-preset', 'ultrafast',
        '-tune', 'zerolatency',
        '-pix_fmt', 'yuv420p',
        '-b:v', '2500k',
        '-maxrate', '2500k',
        '-bufsize', '5000k',
        '-g', '60',
        '-keyint_min', '60',
        '-sc_threshold', '0',

        // Audio encoding
        '-c:a', 'aac',
        '-b:a', '128k',
        '-ar', '48000',

        // Output format
        '-f', 'flv',
        rtmpUrl
      ];

      const ffmpegProcess = spawn('ffmpeg', ffmpegArgs, {
        stdio: ['pipe', 'pipe', 'pipe', 'pipe'] // stdin for video, extra pipe for audio
      });

      // Create separate audio stdin
      ffmpegProcess.audioStdin = ffmpegProcess.stdio[3];

      // Handle FFmpeg output
      ffmpegProcess.stderr.on('data', (data) => {
        const message = data.toString();
        if (message.includes('error') || message.includes('Error')) {
          logger.error(`FFmpeg bridge error for channel ${channelId}: ${message}`);
          this.incrementErrors(channelId);
        }
      });

      // Handle FFmpeg exit
      ffmpegProcess.on('exit', (code, signal) => {
        logger.info(`FFmpeg bridge exited for channel ${channelId}: code=${code}, signal=${signal}`);
        this.ffmpegProcesses.delete(channelId);

        if (code !== 0 && code !== null) {
          this.incrementErrors(channelId);
        }
      });

      // Handle FFmpeg errors
      ffmpegProcess.on('error', (error) => {
        logger.error(`FFmpeg bridge process error for channel ${channelId}`, { error: error.message });
        this.incrementErrors(channelId);
      });

      // Store FFmpeg process
      this.ffmpegProcesses.set(channelId, ffmpegProcess);

      logger.info(`FFmpeg bridge started for channel ${channelId}`);

    } catch (error) {
      logger.error(`Failed to start FFmpeg bridge for channel ${channelId}`, { error: error.message });
      throw error;
    }
  }

  /**
   * Stop WebRTC bridge and cleanup resources
   */
  async stopBridge(channelId) {
    try {
      logger.info(`Stopping WebRTC bridge for channel ${channelId}`);

      // Stop video sink
      const videoSink = this.videoSinks.get(channelId);
      if (videoSink) {
        videoSink.stop();
        this.videoSinks.delete(channelId);
      }

      // Stop audio sink
      const audioSink = this.audioSinks.get(channelId);
      if (audioSink) {
        audioSink.stop();
        this.audioSinks.delete(channelId);
      }

      // Stop FFmpeg process
      const ffmpegProcess = this.ffmpegProcesses.get(channelId);
      if (ffmpegProcess) {
        if (ffmpegProcess.stdin && !ffmpegProcess.stdin.destroyed) {
          ffmpegProcess.stdin.end();
        }
        if (ffmpegProcess.audioStdin && !ffmpegProcess.audioStdin.destroyed) {
          ffmpegProcess.audioStdin.end();
        }

        // Give FFmpeg time to flush buffers
        setTimeout(() => {
          if (ffmpegProcess && !ffmpegProcess.killed) {
            ffmpegProcess.kill('SIGTERM');
          }
        }, 1000);

        this.ffmpegProcesses.delete(channelId);
      }

      // Close peer connection
      const peerConnection = this.peerConnections.get(channelId);
      if (peerConnection) {
        peerConnection.close();
        this.peerConnections.delete(channelId);
      }

      // Clear stream state
      this.streamStates.delete(channelId);

      logger.info(`WebRTC bridge stopped for channel ${channelId}`);

    } catch (error) {
      logger.error(`Failed to stop WebRTC bridge for channel ${channelId}`, { error: error.message });
      throw error;
    }
  }

  /**
   * Get WebRTC offer for signaling
   */
  async createOffer(channelId) {
    try {
      const peerConnection = this.peerConnections.get(channelId);
      if (!peerConnection) {
        throw new Error('Peer connection not found');
      }

      const offer = await peerConnection.createOffer({
        offerToReceiveAudio: true,
        offerToReceiveVideo: true
      });

      await peerConnection.setLocalDescription(offer);

      return {
        type: offer.type,
        sdp: offer.sdp
      };

    } catch (error) {
      logger.error(`Failed to create offer for channel ${channelId}`, { error: error.message });
      throw error;
    }
  }

  /**
   * Set remote answer from client
   */
  async setAnswer(channelId, answerData) {
    try {
      const peerConnection = this.peerConnections.get(channelId);
      if (!peerConnection) {
        throw new Error('Peer connection not found');
      }

      const answer = new RTCSessionDescription({
        type: answerData.type,
        sdp: answerData.sdp
      });

      await peerConnection.setRemoteDescription(answer);

      logger.info(`Remote answer set for channel ${channelId}`);

    } catch (error) {
      logger.error(`Failed to set answer for channel ${channelId}`, { error: error.message });
      throw error;
    }
  }

  /**
   * Handle remote offer from client (client-initiated)
   */
  async handleOffer(channelId, offerData) {
    try {
      const peerConnection = this.peerConnections.get(channelId);
      if (!peerConnection) {
        throw new Error('Peer connection not found');
      }

      const offer = new RTCSessionDescription({
        type: offerData.type,
        sdp: offerData.sdp
      });

      await peerConnection.setRemoteDescription(offer);

      // Create answer
      const answer = await peerConnection.createAnswer();
      await peerConnection.setLocalDescription(answer);

      return {
        type: answer.type,
        sdp: answer.sdp
      };

    } catch (error) {
      logger.error(`Failed to handle offer for channel ${channelId}`, { error: error.message });
      throw error;
    }
  }

  /**
   * Add ICE candidate
   */
  async addIceCandidate(channelId, candidateData) {
    try {
      const peerConnection = this.peerConnections.get(channelId);
      if (!peerConnection) {
        throw new Error('Peer connection not found');
      }

      if (candidateData && candidateData.candidate) {
        const candidate = new RTCIceCandidate(candidateData);
        await peerConnection.addIceCandidate(candidate);
        logger.debug(`ICE candidate added for channel ${channelId}`);
      }

    } catch (error) {
      logger.error(`Failed to add ICE candidate for channel ${channelId}`, { error: error.message });
      throw error;
    }
  }

  /**
   * Get stream status
   */
  getStreamStatus(channelId) {
    const state = this.streamStates.get(channelId);
    if (!state) {
      return { status: 'not_found' };
    }

    const peerConnection = this.peerConnections.get(channelId);
    const ffmpegProcess = this.ffmpegProcesses.get(channelId);

    return {
      status: state.status,
      connectionState: peerConnection ? peerConnection.connectionState : 'none',
      iceConnectionState: peerConnection ? peerConnection.iceConnectionState : 'none',
      ffmpegRunning: ffmpegProcess && !ffmpegProcess.killed,
      uptime: state.startTime ? Math.floor((Date.now() - state.startTime) / 1000) : 0,
      errors: state.errors
    };
  }

  /**
   * Update stream state
   */
  updateStreamState(channelId, updates) {
    const state = this.streamStates.get(channelId);
    if (state) {
      this.streamStates.set(channelId, { ...state, ...updates });
    }
  }

  /**
   * Increment error count
   */
  incrementErrors(channelId) {
    const state = this.streamStates.get(channelId);
    if (state) {
      state.errors = (state.errors || 0) + 1;
      this.streamStates.set(channelId, state);
    }
  }

  /**
   * Cleanup all connections (for graceful shutdown)
   */
  async cleanup() {
    logger.info('Cleaning up all WebRTC bridges...');

    const channelIds = Array.from(this.peerConnections.keys());
    for (const channelId of channelIds) {
      await this.stopBridge(channelId);
    }

    logger.info('All WebRTC bridges cleaned up');
  }
}

// Export singleton instance
export default new WebRTCBridgeService();
