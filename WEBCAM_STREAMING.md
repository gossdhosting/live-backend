# Webcam Streaming Feature

## Overview

The webcam streaming feature allows users to stream directly from their device camera (webcam for web browsers, mobile camera for Flutter app) to multiple platforms in real-time.

## Architecture

```
Camera → WebRTC → WebRTCBridgeService → FFmpeg → nginx-rtmp → Platform Distribution
```

### Flow:

1. **Client** (Browser/Mobile) captures camera feed via MediaDevices API / Camera plugin
2. **WebRTC Connection** established between client and Node.js backend
3. **WebRTCBridgeService** receives raw video/audio frames via WebRTC
4. **FFmpeg Bridge** converts WebRTC frames to RTMP stream
5. **nginx-rtmp** receives the RTMP stream on `rtmp://127.0.0.1:1935/live/{stream_key}`
6. **StreamManager** picks up the RTMP stream and distributes to all configured platforms

## Backend Components

### 1. WebRTCBridgeService
**File:** `src/services/WebRTCBridgeService.js`

**Purpose:** Manages WebRTC peer connections and converts camera streams to RTMP

**Key Methods:**
- `createPeerConnection(channelId, streamKey)` - Create WebRTC connection
- `handleOffer(channelId, offerData)` - Handle client offer and return answer
- `addIceCandidate(channelId, candidateData)` - Handle ICE candidates
- `stopBridge(channelId)` - Stop WebRTC bridge and cleanup

**Technology:**
- **Library:** `wrtc` (Node.js WebRTC implementation)
- **Video Sink:** `RTCVideoSink` to receive video frames
- **Audio Sink:** `RTCAudioSink` to receive audio samples
- **FFmpeg:** Converts raw YUV420 video + PCM audio to RTMP/FLV

### 2. WebRTC Controller
**File:** `src/controllers/webrtcController.js`

**Purpose:** HTTP endpoints for WebRTC signaling

**Endpoints:**
- `POST /api/webrtc/start/:channelId` - Initialize WebRTC session
- `POST /api/webrtc/offer/:channelId` - Handle WebRTC offer (client-initiated)
- `POST /api/webrtc/ice-candidate/:channelId` - Handle ICE candidates
- `POST /api/webrtc/stop/:channelId` - Stop WebRTC streaming
- `GET /api/webrtc/status/:channelId` - Get stream status

### 3. WebRTC Routes
**File:** `src/routes/webrtc.js`

**Authentication:** All routes require valid JWT token and channel ownership

### 4. Channel Model Updates
**File:** `src/models/Channel.js`

**Changes:** Supports `input_type = 'webcam'`

**Valid Input Types:**
- `youtube` - YouTube live stream input
- `video` - Pre-recorded video file
- `rtmp` - RTMP input from OBS/streaming software
- `webcam` - **NEW** - Live camera input via WebRTC

### 5. StreamManager Integration
**File:** `src/ffmpeg/StreamManager.js`

**Changes:**
- Detects `input_type === 'webcam'`
- Sets channel status to `waiting_for_input` until WebRTC connects
- Uses nginx-rtmp as input source (same as RTMP input type)
- Stops WebRTC bridge when stream is stopped
- Cleanup on shutdown (SIGTERM/SIGINT)

## Database Schema

**No schema changes required!** The `channels` table already supports flexible `input_type` values.

Existing schema:
```sql
CREATE TABLE channels (
  id INTEGER PRIMARY KEY,
  user_id INTEGER NOT NULL,
  name TEXT NOT NULL,
  description TEXT,
  input_url TEXT,
  input_type TEXT DEFAULT 'youtube', -- Can be: youtube, video, rtmp, webcam
  stream_key TEXT UNIQUE NOT NULL,
  status TEXT DEFAULT 'stopped',
  -- ... other fields
);
```

## API Usage

### Creating a Webcam Channel

```javascript
POST /api/channels
Authorization: Bearer <token>

{
  "name": "My Webcam Stream",
  "description": "Live from my camera",
  "input_type": "webcam",
  "quality_preset": "720p",
  "auto_restart": false
}
```

### Starting WebRTC Stream

```javascript
// 1. Initialize WebRTC session
POST /api/webrtc/start/:channelId
Authorization: Bearer <token>

// 2. Create WebRTC offer on client
const peerConnection = new RTCPeerConnection();
const offer = await peerConnection.createOffer();
await peerConnection.setLocalDescription(offer);

// 3. Send offer to server
POST /api/webrtc/offer/:channelId
Authorization: Bearer <token>
Body: { "offer": { "type": "offer", "sdp": "..." } }

// 4. Receive answer from server
Response: { "answer": { "type": "answer", "sdp": "..." } }

// 5. Set remote description
await peerConnection.setRemoteDescription(answer);

// 6. Exchange ICE candidates
peerConnection.onicecandidate = (event) => {
  if (event.candidate) {
    POST /api/webrtc/ice-candidate/:channelId
    Body: { "candidate": event.candidate }
  }
};
```

### Stopping WebRTC Stream

```javascript
POST /api/webrtc/stop/:channelId
Authorization: Bearer <token>
```

## FFmpeg Command (Internal)

The WebRTCBridgeService spawns FFmpeg to convert WebRTC to RTMP:

```bash
ffmpeg \
  -f rawvideo -pixel_format yuv420p -video_size 1280x720 -framerate 30 -i pipe:0 \
  -f s16le -ar 48000 -ac 2 -i pipe:1 \
  -c:v libx264 -preset ultrafast -tune zerolatency \
  -b:v 2500k -maxrate 2500k -bufsize 5000k \
  -g 60 -keyint_min 60 -sc_threshold 0 \
  -c:a aac -b:a 128k -ar 48000 \
  -f flv rtmp://127.0.0.1:1935/live/{stream_key}
```

**Inputs:**
- `pipe:0` - Raw video frames (YUV420) from WebRTC
- `pipe:1` - Raw audio samples (PCM s16le) from WebRTC

**Output:**
- RTMP/FLV stream to nginx-rtmp server

## Security Considerations

1. **Authentication:** All WebRTC endpoints require valid JWT token
2. **Authorization:** Users can only create WebRTC connections for their own channels
3. **Channel Ownership:** Validated on every API call
4. **ICE Servers:** Uses public STUN servers (stun.l.google.com)
5. **Media Encryption:** WebRTC uses DTLS-SRTP for encrypted media

## Performance Notes

**Per Webcam Stream:**
- **CPU:** ~30-50% of one core (software encoding)
- **Memory:** ~200-300 MB
- **Bandwidth:**
  - Upload from client: ~2-3 Mbps (720p)
  - Download to platforms: Depends on platform count

**Recommended Capacity:**
- 2-4 concurrent webcam streams per server (CPU-bound)
- Use GPU encoding (NVENC) for higher capacity

## Limitations

1. **Browser Support:** Requires WebRTC-capable browser (Chrome, Firefox, Safari, Edge)
2. **Mobile Support:** Requires native implementation (Flutter WebRTC plugin)
3. **Network Quality:** Requires stable internet connection (2-3 Mbps upload minimum)
4. **Concurrent Streams:** Limited by server CPU capacity
5. **Latency:** ~3-5 seconds end-to-end (WebRTC → RTMP → Platform)

## Troubleshooting

### "Peer connection not found" Error
- Ensure `/api/webrtc/start/:channelId` was called first
- Check channel exists and user owns it

### "Camera not detected on RTMP server" Error
- WebRTC connection failed or closed prematurely
- Check network connectivity
- Verify ICE candidates were exchanged

### High CPU Usage
- Use lower quality preset (480p instead of 720p)
- Reduce frame rate to 24fps
- Consider hardware encoding (NVENC/QuickSync)

### Video/Audio Out of Sync
- Check FFmpeg buffer sizes
- Ensure consistent frame rate from camera
- Verify audio sample rate is 48000 Hz

## Future Enhancements

1. **Adaptive Bitrate:** Adjust quality based on network conditions
2. **GPU Encoding:** NVENC/QuickSync support for higher throughput
3. **Multiple Cameras:** Picture-in-picture support
4. **Beauty Filters:** Real-time face smoothing and effects
5. **Screen Share:** Combined camera + screen share
6. **Lower Latency:** Consider SRT protocol instead of RTMP

## Testing

### Local Testing

1. Create a webcam channel:
```bash
curl -X POST http://localhost:3000/api/channels \
  -H "Authorization: Bearer <token>" \
  -H "Content-Type: application/json" \
  -d '{"name": "Test Webcam", "input_type": "webcam", "quality_preset": "720p"}'
```

2. Open browser console and test WebRTC connection:
```javascript
// See admin-panel implementation for full example
```

3. Check nginx-rtmp stats:
```bash
# If nginx-rtmp stats are enabled
curl http://localhost:8080/stat
```

4. Verify stream is distributed to platforms via StreamManager

### Production Deployment

1. Ensure `wrtc` library is installed: `npm install wrtc@0.4.7`
2. Deploy code to server
3. Restart backend service: `pm2 restart backend`
4. Test with real camera device
5. Monitor CPU/memory usage under load

## Dependencies

```json
{
  "wrtc": "^0.4.7"
}
```

**Note:** The `wrtc` package includes native bindings and may require build tools on some systems.

## Related Files

- `src/services/WebRTCBridgeService.js` - WebRTC bridge service
- `src/controllers/webrtcController.js` - WebRTC HTTP endpoints
- `src/routes/webrtc.js` - WebRTC route definitions
- `src/ffmpeg/StreamManager.js` - Stream orchestration
- `src/models/Channel.js` - Channel data model
- `server.js` - Route registration

## Support

For issues or questions about webcam streaming:
1. Check logs: `logs/app.log` and `logs/ffmpeg/webrtc_bridge_{channel_id}.log`
2. Verify WebRTC connection state in browser console
3. Check nginx-rtmp server status
4. Review this documentation for troubleshooting steps
