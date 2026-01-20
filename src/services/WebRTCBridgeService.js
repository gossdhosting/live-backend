import { spawn } from 'child_process';
import wrtc from 'wrtc';
import logger from '../utils/logger.js';
import Channel from '../models/Channel.js';
import streamManager from '../ffmpeg/StreamManager.js';

const { RTCPeerConnection, RTCSessionDescription, RTCIceCandidate, nonstandard } = wrtc;
const { RTCAudioSink, RTCVideoSink } = nonstandard;

/**
 * WebRTC Bridge Service
 * Converts WebRTC camera streams to RTMP for ingestion into nginx-rtmp server
 */
class WebRTCBridgeService {
  constructor() {
    // Store active peer connections and FFmpeg processes
    this.peerConnections = new Map(); // channelId -> RTCPeerConnection (with candidateQueue and remoteDescriptionSet properties)
    this.ffmpegProcesses = new Map(); // channelId -> FFmpeg process
    this.videoSinks = new Map(); // channelId -> RTCVideoSink
    this.audioSinks = new Map(); // channelId -> RTCAudioSink
    this.streamStates = new Map(); // channelId -> { status, startTime, errors }
    this.ffmpegStdinClosed = new Map(); // channelId -> boolean (tracks if FFmpeg stdin has been closed)
    this.firstFrameReceived = new Map(); // channelId -> boolean (tracks if first frame received)
    this.platformStreamingStarted = new Map(); // channelId -> boolean (tracks if platform streaming already started)
    this.platformStreamingTimers = new Map(); // channelId -> setTimeout reference (for cleanup)
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

      // Create peer connection with STUN and TURN servers for NAT traversal
      const peerConnection = new RTCPeerConnection({
        iceServers: [
          { urls: 'stun:stun.l.google.com:19302' },
          { urls: 'stun:stun1.l.google.com:19302' },
          // Free TURN server for testing (replace with your own in production)
          {
            urls: 'turn:openrelay.metered.ca:80',
            username: 'openrelayproject',
            credential: 'openrelayproject'
          },
          {
            urls: 'turn:openrelay.metered.ca:443',
            username: 'openrelayproject',
            credential: 'openrelayproject'
          },
          {
            urls: 'turn:openrelay.metered.ca:443?transport=tcp',
            username: 'openrelayproject',
            credential: 'openrelayproject'
          }
        ],
        iceCandidatePoolSize: 10,
        // Configure UDP port range for media traffic (requires firewall to allow these ports)
        portRange: { min: 50000, max: 50100 }
      });

      // Initialize properties for race condition handling
      peerConnection.remoteDescriptionSet = false;
      peerConnection.candidateQueue = [];

      // CRITICAL: Add transceivers so server knows it's a receiver
      // This "primes" the connection to listen for audio and video from the browser
      logger.info(`Adding transceivers for channel ${channelId} to receive media`);
      peerConnection.addTransceiver('video', { direction: 'recvonly' });
      peerConnection.addTransceiver('audio', { direction: 'recvonly' });
      logger.info(`Transceivers added for channel ${channelId}`);

      // Handle incoming tracks (video and audio)
      peerConnection.ontrack = (event) => {
        const track = event.track;
        logger.info(`WebRTC track received for channel ${channelId}: ${track.kind}`);
        console.log(`[WebRTC Bridge] Track received - Kind: ${track.kind}, ID: ${track.id}, Label: ${track.label}`);

        // Check transceiver direction for debugging
        const transceiver = peerConnection.getTransceivers().find(t => t.receiver && t.receiver.track === track);
        if (transceiver) {
          logger.info(`[WebRTC Bridge] Transceiver for ${track.kind}:`, {
            direction: transceiver.direction,
            currentDirection: transceiver.currentDirection
          });
          console.log(`[WebRTC Bridge] Transceiver direction: ${transceiver.direction}, current: ${transceiver.currentDirection}`);
        }

        if (track.kind === 'video') {
          this.handleVideoTrack(channelId, track, streamKey);
        } else if (track.kind === 'audio') {
          this.handleAudioTrack(channelId, track, streamKey);
        }
      };

      // Handle connection state changes
      peerConnection.onconnectionstatechange = async () => {
        logger.info(`WebRTC connection state for channel ${channelId}: ${peerConnection.connectionState}`);

        if (peerConnection.connectionState === 'connected') {
          this.updateStreamState(channelId, { status: 'connected', startTime: Date.now() });
          // Platform streaming is now triggered directly from first frame handler
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
      logger.info(`Handling video track for channel ${channelId}`, {
        trackId: track.id,
        trackKind: track.kind,
        trackEnabled: track.enabled,
        trackReadyState: track.readyState,
        trackMuted: track.muted
      });
      console.log(`[WebRTC Bridge] Creating video sink for track ${track.id}, enabled: ${track.enabled}, readyState: ${track.readyState}`);

      const videoSink = new RTCVideoSink(track);
      this.videoSinks.set(channelId, videoSink);

      let frameCount = 0;
      let currentResolution = null; // Track current FFmpeg resolution

      // WORKAROUND for wrtc 0.4.7 "cold start" issue:
      // Delay onframe assignment to ensure C++ thread is synchronized with Node.js event loop
      const attachVideoSinkHandler = () => {
        videoSink.onframe = async ({ frame }) => {
          console.log(`[WebRTC Bridge] !!! FRAME DETECTED IN CALLBACK !!! ${frame.width}x${frame.height}, frame ${frameCount + 1} for channel ${channelId}`);
          try {
            frameCount++;

            // Check if resolution has changed (adaptive bitrate)
            const frameResolution = `${frame.width}x${frame.height}`;

            // CRITICAL FIX: Check if this is the first frame AND FFmpeg bridge not started yet
            // This handles case where connection persists across restart (frameCount != 1)
            const ffmpegBridgeRunning = this.ffmpegProcesses.has(channelId);

            if (frameCount === 1 || !ffmpegBridgeRunning) {
              console.log(`[WebRTC Bridge] FIRST FRAME! ${frameResolution} (frameCount: ${frameCount}, bridge running: ${ffmpegBridgeRunning})`);
              logger.info(`First video frame received for channel ${channelId}: ${frameResolution}`);
              currentResolution = frameResolution;

              // Only start FFmpeg bridge if not already running
              if (!ffmpegBridgeRunning) {
                this.startFFmpegBridge(channelId, streamKey, frame);
              }

              // CRITICAL FIX: Start platform streaming only if NOT already started
              const platformAlreadyStarted = this.platformStreamingStarted.get(channelId);
              console.log(`[Platform Streaming Check] channel ${channelId}: platformAlreadyStarted = ${platformAlreadyStarted}`);
              if (!platformAlreadyStarted) {
                console.log(`[Platform Streaming] Scheduling start for channel ${channelId} in 3 seconds`);
                logger.info(`Scheduling platform streaming start for channel ${channelId} in 3 seconds`);

                // Clear any existing timer first
                const existingTimer = this.platformStreamingTimers.get(channelId);
                if (existingTimer) {
                  clearTimeout(existingTimer);
                  logger.warn(`Cleared existing platform streaming timer for channel ${channelId}`);
                }

                const timer = setTimeout(async () => {
                  console.log(`[Platform Streaming Timer] Fired for channel ${channelId}`);
                  try {
                    // Double-check it hasn't been started by another code path
                    if (!this.platformStreamingStarted.get(channelId)) {
                      console.log(`[Platform Streaming] STARTING streamManager.startStream(${channelId})`);
                      logger.info(`Starting platform streaming for webcam channel ${channelId} after first frame`);
                      await streamManager.startStream(channelId);
                      this.platformStreamingStarted.set(channelId, true);
                      this.platformStreamingTimers.delete(channelId);
                      logger.info(`Platform streaming started successfully for channel ${channelId}`);
                    } else {
                      logger.warn(`Platform streaming already started for channel ${channelId}, skipping`);
                    }
                  } catch (err) {
                    logger.error(`Failed to start platform streaming for channel ${channelId}`, { error: err.message });
                    this.platformStreamingTimers.delete(channelId);
                    // Retry after 5 seconds if failed
                    setTimeout(() => this.retryPlatformStreaming(channelId), 5000);
                  }
                }, 3000); // 3 second delay to let WebRTC→RTMP bridge stabilize

                this.platformStreamingTimers.set(channelId, timer);
              } else {
                logger.info(`Platform streaming already started for channel ${channelId}, skipping trigger`);
              }
            } else if (currentResolution !== frameResolution) {
              // Resolution changed - restart FFmpeg with new dimensions
              logger.warn(`Resolution changed for channel ${channelId}: ${currentResolution} -> ${frameResolution}`);
              logger.info(`Restarting FFmpeg bridge with new resolution...`);

              // Stop current FFmpeg process
              const ffmpegProcess = this.ffmpegProcesses.get(channelId);
              if (ffmpegProcess && !ffmpegProcess.killed) {
                try {
                  if (ffmpegProcess.stdin && !ffmpegProcess.stdin.destroyed) {
                    ffmpegProcess.stdin.end();
                  }
                  if (ffmpegProcess.audioStdin && !ffmpegProcess.audioStdin.destroyed) {
                    ffmpegProcess.audioStdin.end();
                  }
                  // Mark stdin as closed
                  this.ffmpegStdinClosed.set(channelId, true);
                  ffmpegProcess.kill('SIGTERM');
                } catch (err) {
                  logger.error(`Error killing FFmpeg process for resolution change: ${err.message}`);
                }
              }

              // Start new FFmpeg with updated resolution
              currentResolution = frameResolution;
              this.startFFmpegBridge(channelId, streamKey, frame);
              logger.info(`FFmpeg restarted with resolution ${frameResolution} for channel ${channelId}`);
            }

            // Write frame to FFmpeg stdin
            const ffmpegProcess = this.ffmpegProcesses.get(channelId);
            const stdinClosed = this.ffmpegStdinClosed.get(channelId);

            if (ffmpegProcess && ffmpegProcess.stdin && !ffmpegProcess.stdin.destroyed && !stdinClosed) {
              const yuv = this.convertToYUV420(frame);
              try {
                ffmpegProcess.stdin.write(yuv);
              } catch (err) {
                logger.error(`Failed to write video frame for channel ${channelId}`, { error: err.message });
                // Mark stdin as closed to prevent further write attempts
                this.ffmpegStdinClosed.set(channelId, true);
              }
            }
          } catch (error) {
            logger.error(`Unhandled error in video frame handler for channel ${channelId}`, { error: error.message, stack: error.stack });
          }
        };
        console.log(`[WebRTC Bridge] Video sink onframe handler attached (delayed) for channel ${channelId}`);
      };

      // Call the attachment function after 500ms delay (wrtc 0.4.7 workaround)
      setTimeout(() => {
        attachVideoSinkHandler();

        // CRITICAL FIX: Toggle track enabled to force wrtc to start sending frames
        // This fixes the "cold start" issue where track is live but no frames flow
        track.enabled = false;
        setTimeout(() => {
          track.enabled = true;
          console.log(`[WebRTC Bridge] Track enabled toggled for channel ${channelId}`);
        }, 100);
      }, 500);
      console.log(`[WebRTC Bridge] Scheduled delayed onframe attachment in 500ms for channel ${channelId}`);

      logger.info(`Video track handler attached for channel ${channelId}`);
      console.log(`[WebRTC Bridge] Sink reference stored in Map, has ${this.videoSinks.size} video sinks total`);
      console.log(`[WebRTC Bridge] VideoSink object:`, {
        hasOnframe: typeof videoSink.onframe === 'function',
        sinkToString: videoSink.toString()
      });

      // Debug: Log when frames start/stop
      setTimeout(() => {
        if (frameCount === 0) {
          logger.warn(`NO VIDEO FRAMES received after 5 seconds for channel ${channelId}`);
          console.log(`[WebRTC Bridge] WARNING: Video sink created but no frames received yet`);
          console.log(`[WebRTC Bridge] Track state after 5s:`, {
            enabled: track.enabled,
            readyState: track.readyState,
            muted: track.muted
          });
        } else {
          logger.info(`Video frames flowing normally for channel ${channelId}: ${frameCount} frames in 5 seconds`);
        }
      }, 5000);
    } catch (error) {
      logger.error(`Failed to handle video track for channel ${channelId}`, { error: error.message, stack: error.stack });
    }
  }

  /**
   * Handle incoming audio track
   */
  handleAudioTrack(channelId, track, streamKey) {
    try {
      logger.info(`Handling audio track for channel ${channelId}`, {
        trackId: track.id,
        trackKind: track.kind,
        trackEnabled: track.enabled,
        trackReadyState: track.readyState,
        trackMuted: track.muted
      });
      console.log(`[WebRTC Bridge] Creating audio sink for track ${track.id}, enabled: ${track.enabled}, readyState: ${track.readyState}`);

      const audioSink = new RTCAudioSink(track);
      this.audioSinks.set(channelId, audioSink);

      audioSink.ondata = ({ samples }) => {
        console.log(`[WebRTC Bridge] AUDIO ONDATA FIRED! Samples: ${samples.length} for channel ${channelId}`);
        try {
          // Write audio samples to FFmpeg
          const ffmpegProcess = this.ffmpegProcesses.get(channelId);
          const stdinClosed = this.ffmpegStdinClosed.get(channelId);

          if (ffmpegProcess && ffmpegProcess.audioStdin && !ffmpegProcess.audioStdin.destroyed && !stdinClosed) {
            try {
              // Convert samples to buffer
              const buffer = Buffer.from(samples.buffer);
              ffmpegProcess.audioStdin.write(buffer);
            } catch (err) {
              logger.error(`Failed to write audio samples for channel ${channelId}`, { error: err.message });
              // Mark stdin as closed to prevent further write attempts
              this.ffmpegStdinClosed.set(channelId, true);
            }
          }
        } catch (error) {
          logger.error(`Unhandled error in audio data handler for channel ${channelId}`, { error: error.message, stack: error.stack });
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

    // Convert frame.data (Uint8ClampedArray) to Buffer
    const frameBuffer = Buffer.from(frame.data);

    // Copy Y, U, V planes from frame data
    frameBuffer.copy(yuv, 0, 0, ySize); // Y plane
    frameBuffer.copy(yuv, ySize, ySize, ySize + uvSize); // U plane
    frameBuffer.copy(yuv, ySize + uvSize, ySize + uvSize, ySize + uvSize * 2); // V plane

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

      // CRITICAL: Use 'nice' to lower FFmpeg CPU priority and prevent event loop blocking
      // This prevents the Node.js server from becoming unresponsive when FFmpeg starts
      const ffmpegProcess = spawn('nice', ['-n', '10', 'ffmpeg', ...ffmpegArgs], {
        stdio: ['pipe', 'pipe', 'pipe', 'pipe'] // stdin for video, extra pipe for audio
      });

      // Create separate audio stdin
      ffmpegProcess.audioStdin = ffmpegProcess.stdio[3];

      // Handle FFmpeg stdin errors (CRITICAL: prevents EPIPE/ECONNRESET crashes)
      if (ffmpegProcess.stdin) {
        ffmpegProcess.stdin.on('error', (error) => {
          logger.warn(`FFmpeg video stdin error for channel ${channelId}: ${error.message}`);
          this.ffmpegStdinClosed.set(channelId, true);
        });
      }

      if (ffmpegProcess.audioStdin) {
        ffmpegProcess.audioStdin.on('error', (error) => {
          logger.warn(`FFmpeg audio stdin error for channel ${channelId}: ${error.message}`);
        });
      }

      // Handle FFmpeg output
      ffmpegProcess.stderr.on('data', (data) => {
        const message = data.toString();
        if (message.includes('error') || message.includes('Error')) {
          logger.error(`FFmpeg bridge error for channel ${channelId}: ${message}`);
          this.incrementErrors(channelId);
        }
      });

      // Handle FFmpeg stderr errors
      ffmpegProcess.stderr.on('error', (error) => {
        logger.warn(`FFmpeg stderr error for channel ${channelId}: ${error.message}`);
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

      // Mark stdin as open
      this.ffmpegStdinClosed.set(channelId, false);

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

      // CRITICAL FIX: Clear platform streaming timer if exists
      const timer = this.platformStreamingTimers.get(channelId);
      if (timer) {
        clearTimeout(timer);
        this.platformStreamingTimers.delete(channelId);
        logger.info(`Cleared platform streaming timer for channel ${channelId}`);
      }

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

        // Mark stdin as closed
        this.ffmpegStdinClosed.set(channelId, true);

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

      // CRITICAL FIX: Clear ALL state tracking maps
      this.streamStates.delete(channelId);
      this.ffmpegStdinClosed.delete(channelId);
      this.firstFrameReceived.delete(channelId);
      this.platformStreamingStarted.delete(channelId);

      // Update channel status to stopped
      try {
        await Channel.update(channelId, { status: 'stopped' });
        logger.info(`Channel ${channelId} status updated to stopped`);
      } catch (err) {
        logger.error(`Failed to update channel status for ${channelId}`, { error: err.message });
      }

      logger.info(`WebRTC bridge stopped and all state cleared for channel ${channelId}`);

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

      // Set up candidate queue on the peer connection object itself
      if (!peerConnection.candidateQueue) {
        peerConnection.candidateQueue = [];
      }
      peerConnection.remoteDescriptionSet = false;

      // Set remote description
      await peerConnection.setRemoteDescription(offer);

      // Mark that remote description is now set
      peerConnection.remoteDescriptionSet = true;

      // Process any queued ICE candidates that arrived before setRemoteDescription
      logger.info(`Processing ${peerConnection.candidateQueue.length} queued ICE candidates for channel ${channelId}`);
      while (peerConnection.candidateQueue.length > 0) {
        const candidate = peerConnection.candidateQueue.shift();
        try {
          await peerConnection.addIceCandidate(new RTCIceCandidate(candidate));
          logger.debug(`Queued ICE candidate added for channel ${channelId}`);
        } catch (err) {
          logger.warn(`Failed to add queued ICE candidate for channel ${channelId}`, {
            error: err.message
          });
        }
      }

      // Create answer
      const answer = await peerConnection.createAnswer();
      await peerConnection.setLocalDescription(answer);

      // CRITICAL FIX: Wait for ICE gathering to complete before returning answer
      // This bundles all server ICE candidates into the SDP for HTTP-based signaling
      if (peerConnection.iceGatheringState !== 'complete') {
        logger.info(`Waiting for ICE gathering to complete for channel ${channelId}...`);
        await new Promise((resolve) => {
          const checkState = () => {
            logger.debug(`ICE gathering state for channel ${channelId}: ${peerConnection.iceGatheringState}`);
            if (peerConnection.iceGatheringState === 'complete') {
              peerConnection.removeEventListener('icegatheringstatechange', checkState);
              logger.info(`ICE gathering completed for channel ${channelId}`);
              resolve();
            }
          };
          peerConnection.addEventListener('icegatheringstatechange', checkState);

          // Timeout after 5 seconds if ICE gathering doesn't complete
          setTimeout(() => {
            peerConnection.removeEventListener('icegatheringstatechange', checkState);
            logger.warn(`ICE gathering timeout for channel ${channelId}, proceeding anyway`);
            resolve();
          }, 5000);
        });
      } else {
        logger.info(`ICE gathering already complete for channel ${channelId}`);
      }

      // Return the LocalDescription which now includes all bundled server ICE candidates
      const finalAnswer = {
        type: peerConnection.localDescription.type,
        sdp: peerConnection.localDescription.sdp
      };

      logger.info(`Answer created for channel ${channelId} with bundled ICE candidates`);

      return finalAnswer;

    } catch (error) {
      logger.error(`Failed to handle offer for channel ${channelId}`, { error: error.message });
      throw error;
    }
  }

  /**
   * Add ICE candidate (handles race condition with candidate queue)
   */
  async addIceCandidate(channelId, candidateData) {
    try {
      const peerConnection = this.peerConnections.get(channelId);
      if (!peerConnection) {
        throw new Error('Peer connection not found');
      }

      if (!candidateData || !candidateData.candidate) {
        logger.debug(`Skipping empty ICE candidate for channel ${channelId}`);
        return;
      }

      // Initialize candidate queue if not present
      if (!peerConnection.candidateQueue) {
        peerConnection.candidateQueue = [];
      }

      // Check if remote description is set using the peer connection's own property
      if (!peerConnection.remoteDescriptionSet) {
        // Queue the candidate - remote description not set yet (race condition)
        logger.debug(`Queueing ICE candidate for channel ${channelId} - remote description not set yet`);
        peerConnection.candidateQueue.push(candidateData);
        logger.info(`Queued ICE candidate for channel ${channelId} (queue size: ${peerConnection.candidateQueue.length})`);
        return;
      }

      // Add candidate immediately if remote description is already set
      const candidate = new RTCIceCandidate(candidateData);
      await peerConnection.addIceCandidate(candidate);
      logger.debug(`ICE candidate added immediately for channel ${channelId}`);

    } catch (error) {
      // Don't throw error for ICE candidate failures - just log them
      // ICE candidates can fail for valid reasons (e.g., candidate not compatible)
      logger.warn(`Failed to add ICE candidate for channel ${channelId}`, {
        error: error.message,
        candidate: candidateData?.candidate?.substring(0, 50)
      });
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
   * Retry platform streaming after failure
   */
  async retryPlatformStreaming(channelId) {
    try {
      // Check if WebRTC bridge still active
      if (!this.ffmpegProcesses.has(channelId)) {
        logger.warn(`WebRTC bridge not active for channel ${channelId}, skipping platform streaming retry`);
        return;
      }

      // Check if already started
      if (this.platformStreamingStarted.get(channelId)) {
        logger.info(`Platform streaming already running for channel ${channelId}, skipping retry`);
        return;
      }

      logger.info(`Retrying platform streaming for channel ${channelId}`);
      await streamManager.startStream(channelId);
      this.platformStreamingStarted.set(channelId, true);
      logger.info(`Platform streaming retry successful for channel ${channelId}`);
    } catch (err) {
      logger.error(`Platform streaming retry failed for channel ${channelId}`, { error: err.message });
      // Don't retry again - let user manually restart
    }
  }

  /**
   * Cleanup all connections (for graceful shutdown)
   */
  async cleanup() {
    logger.info('Cleaning up all WebRTC bridges...');

    // Clear all timers first
    for (const timer of this.platformStreamingTimers.values()) {
      clearTimeout(timer);
    }
    this.platformStreamingTimers.clear();

    const channelIds = Array.from(this.peerConnections.keys());
    for (const channelId of channelIds) {
      await this.stopBridge(channelId);
    }

    logger.info('All WebRTC bridges cleaned up');
  }
}

// Export singleton instance
export default new WebRTCBridgeService();
