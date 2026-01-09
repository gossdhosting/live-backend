# 🚀 Production Scaling Guide - ZebCast Streaming Platform

## ⚠️ Critical SaaS Architecture Issues & Solutions

This document outlines the architectural improvements needed to scale ZebCast from a single-server setup to a production-ready SaaS platform handling hundreds of concurrent streams.

---

## 🔴 **CRITICAL ISSUE #1: In-Memory State = Data Loss on Restart**

### Current Problem
The `StreamManager` stores all stream state in JavaScript `Map` objects:
- `this.processes` - Active FFmpeg processes
- `this.rtmpConnectionStatus` - RTMP connection states
- `this.healthMetrics` - Stream health data

### Why This is Critical
**On server restart/crash/deployment:**
1. All in-memory state is **lost**
2. FFmpeg processes become **orphaned zombies**
3. Dashboard shows streams as "stopped" but they're actually running
4. Users cannot control their streams
5. Server resources leak (CPU, memory, file handles)

### Solution: Redis-Based State Persistence

#### Phase 1: Add Redis (Immediate Priority)
```javascript
// Install Redis client
npm install ioredis

// backend/src/redis/RedisStateManager.js
import Redis from 'ioredis';

class RedisStateManager {
  constructor() {
    this.redis = new Redis({
      host: process.env.REDIS_HOST || 'localhost',
      port: process.env.REDIS_PORT || 6379,
      password: process.env.REDIS_PASSWORD,
      retryStrategy: (times) => Math.min(times * 50, 2000)
    });
  }

  // Store stream state
  async saveStreamState(channelId, state) {
    await this.redis.hmset(`stream:${channelId}`, {
      pid: state.pid,
      status: state.status,
      startTime: state.startTime,
      outputPath: state.outputPath,
      qualityPreset: state.qualityPreset
    });
    await this.redis.expire(`stream:${channelId}`, 86400); // 24 hour TTL
  }

  // Get stream state
  async getStreamState(channelId) {
    const state = await this.redis.hgetall(`stream:${channelId}`);
    return Object.keys(state).length ? state : null;
  }

  // Delete stream state
  async deleteStreamState(channelId) {
    await this.redis.del(`stream:${channelId}`);
  }

  // Get all active stream IDs
  async getActiveStreamIds() {
    return await this.redis.keys('stream:*');
  }

  // Store RTMP connection status
  async saveRtmpStatus(channelId, destId, status) {
    await this.redis.hset(`rtmp:${channelId}`, destId, JSON.stringify(status));
  }

  async getRtmpStatuses(channelId) {
    const statuses = await this.redis.hgetall(`rtmp:${channelId}`);
    const parsed = {};
    for (const [key, value] of Object.entries(statuses)) {
      parsed[key] = JSON.parse(value);
    }
    return parsed;
  }
}

export default new RedisStateManager();
```

#### Integration into StreamManager
```javascript
// In startStream(), after spawning FFmpeg:
await redisState.saveStreamState(channelId, {
  pid: ffmpegProcess.pid,
  status: 'running',
  startTime: Date.now(),
  outputPath,
  qualityPreset
});

// On server startup (constructor):
async adoptOrphanedStreams() {
  const activeStreamIds = await redisState.getActiveStreamIds();

  for (const key of activeStreamIds) {
    const channelId = key.replace('stream:', '');
    const state = await redisState.getStreamState(channelId);

    // Check if process actually exists
    try {
      process.kill(state.pid, 0); // Signal 0 checks existence without killing
      // Process exists - adopt it
      this.processes.set(channelId, { /* reconstruct from state */ });
      logger.info(`Adopted orphaned stream ${channelId} (PID: ${state.pid})`);
    } catch (err) {
      // Process doesn't exist - clean up
      await redisState.deleteStreamState(channelId);
      Channel.updateStatus(channelId, 'stopped');
      logger.warn(`Cleaned up stale stream state ${channelId}`);
    }
  }
}
```

#### Benefits
✅ Survives restarts/crashes
✅ Multiple servers can see same state (load balancing)
✅ Health checks can detect zombie processes
✅ Enables horizontal scaling

---

## 🔴 **CRITICAL ISSUE #2: Single Server Bottleneck**

### Current Problem
- `StreamManager` runs **inside** your Express server process
- Video encoding is **CPU-intensive** (10-20 streams max per server)
- As encoding load increases, **API becomes unresponsive**
- Users experience **timeouts** and **slow page loads**

### Why This Happens
One 1080p stream at 6000k bitrate consumes:
- **~60-80% of 1 CPU core** (with veryfast preset)
- **300-500 MB RAM**
- **Network I/O** for HLS + multiple RTMP outputs

**Math**: 2-core VPS = max 2-3 streams before API freezes

### Solution: Worker Queue Architecture

#### Phase 1: Decouple API from Workers (BullMQ)

```bash
npm install bullmq ioredis
```

```javascript
// backend/src/queues/streamQueue.js
import { Queue, Worker } from 'bullmq';
import Redis from 'ioredis';

const connection = new Redis({
  host: process.env.REDIS_HOST || 'localhost',
  port: 6379,
  maxRetriesPerRequest: null
});

// Queue for stream start/stop commands
export const streamQueue = new Queue('streams', { connection });

// API Server adds jobs to queue
export async function startStreamJob(channelId, userId) {
  await streamQueue.add('start-stream', {
    channelId,
    userId,
    timestamp: Date.now()
  }, {
    attempts: 3,
    backoff: { type: 'exponential', delay: 2000 }
  });
}

export async function stopStreamJob(channelId) {
  await streamQueue.add('stop-stream', {
    channelId,
    timestamp: Date.now()
  });
}
```

```javascript
// backend/workers/streamWorker.js (SEPARATE PROCESS)
import { Worker } from 'bullmq';
import streamManager from '../src/ffmpeg/StreamManager.js';

const worker = new Worker('streams', async (job) => {
  const { name, data } = job;

  if (name === 'start-stream') {
    await streamManager.startStream(data.channelId, data.userId);
    return { success: true };
  } else if (name === 'stop-stream') {
    await streamManager.stopStream(data.channelId);
    return { success: true };
  }
}, {
  connection: { host: 'localhost', port: 6379 },
  concurrency: 5 // Max 5 concurrent FFmpeg processes per worker
});

worker.on('completed', (job) => {
  console.log(`Job ${job.id} completed:`, job.returnvalue);
});

worker.on('failed', (job, err) => {
  console.error(`Job ${job.id} failed:`, err);
});

console.log('Stream worker started');
```

#### Run Workers Separately
```json
// package.json
{
  "scripts": {
    "start": "node server.js",
    "worker": "node workers/streamWorker.js"
  }
}
```

```bash
# Terminal 1 - API Server
npm start

# Terminal 2 - Worker Server
npm run worker

# Production: Use PM2
pm2 start server.js --name api
pm2 start workers/streamWorker.js --name worker -i 2
```

#### Update API Controllers
```javascript
// backend/src/controllers/channelController.js
import { startStreamJob } from '../queues/streamQueue.js';

export const startStream = async (req, res) => {
  const { id } = req.params;

  // Add job to queue instead of calling streamManager directly
  await startStreamJob(id, req.user.id);

  res.json({
    message: 'Stream start queued',
    status: 'pending'
  });
};
```

#### Benefits
✅ API server stays fast (just adds jobs to queue)
✅ Workers can be on different servers
✅ Easy to scale: Add more worker servers
✅ Failed jobs auto-retry
✅ Job progress tracking

---

## 🟡 **MEDIUM PRIORITY: Resource Limits & Monitoring**

### CPU/Memory Limits per Stream

```javascript
// backend/src/ffmpeg/StreamManager.js
import { spawn } from 'child_process';

const ffmpegProcess = spawn(this.ffmpegPath, ffmpegArgs, {
  // Limit CPU usage (Linux only)
  // Use cgroups or systemd for better control
  env: { ...process.env }
});

// Monitor resource usage
setInterval(() => {
  const usage = process.cpuUsage();
  const memory = process.memoryUsage();

  if (usage.user > THRESHOLD) {
    logger.warn(`High CPU usage detected: ${usage.user}`);
    // Consider killing low-priority streams
  }
}, 10000);
```

### Health Monitoring with Prometheus

```bash
npm install prom-client
```

```javascript
// backend/src/metrics/prometheus.js
import { register, Counter, Gauge, Histogram } from 'prom-client';

export const activeStreamsGauge = new Gauge({
  name: 'active_streams_total',
  help: 'Number of active streams'
});

export const streamStartCounter = new Counter({
  name: 'stream_starts_total',
  help: 'Total number of stream starts'
});

export const streamDuration = new Histogram({
  name: 'stream_duration_seconds',
  help: 'Stream duration distribution'
});

// Expose /metrics endpoint
app.get('/metrics', async (req, res) => {
  res.set('Content-Type', register.contentType);
  res.end(await register.metrics());
});
```

---

## 🟢 **PHASE 2: Advanced Scaling (50+ Concurrent Streams)**

### Hardware Encoding (NVIDIA GPUs)

```javascript
// Use NVENC for 10x faster encoding
const ffmpegArgs = [
  '-hwaccel', 'cuda',
  '-hwaccel_output_format', 'cuda',
  '-c:v', 'h264_nvenc', // NVIDIA GPU encoder
  '-preset', 'p4',      // NVENC preset (p1-p7)
  '-b:v', resolution.bitrate,
  // ... rest of args
];
```

**Benefits:**
- One GPU can handle **20-30 streams** (vs 2-3 with software)
- Frees CPU for other tasks

### CDN Integration for HLS

```javascript
// backend/src/cdn/CloudflareCDN.js
export async function uploadHLSSegment(channelId, segmentFile) {
  // Upload to R2/S3/Cloudflare
  await s3.putObject({
    Bucket: 'zebcast-hls',
    Key: `${channelId}/${path.basename(segmentFile)}`,
    Body: fs.createReadStream(segmentFile),
    ContentType: 'video/mp2t',
    CacheControl: 'max-age=3600'
  });
}
```

**Serve HLS via CDN:**
```
https://cdn.zebcast.com/channel_123/index.m3u8
```

---

## 📊 **Recommended Architecture for 100+ Streams**

```
┌─────────────────────────────────────────────────────┐
│                   Load Balancer                     │
│               (NGINX / Cloudflare)                  │
└──────────────────┬──────────────────────────────────┘
                   │
         ┌─────────┴─────────┐
         │                   │
    ┌────▼────┐         ┌────▼────┐
    │ API #1  │         │ API #2  │  (Express/Node.js)
    │ (API)   │         │ (API)   │  - Handles requests
    └────┬────┘         └────┬────┘  - Adds jobs to queue
         │                   │
         └─────────┬─────────┘
                   │
              ┌────▼────┐
              │  Redis  │  (Queue + State)
              └────┬────┘
                   │
         ┌─────────┴─────────┐
         │                   │
    ┌────▼────┐         ┌────▼────┐
    │ Worker  │         │ Worker  │  (FFmpeg Encoding)
    │   #1    │         │   #2    │  - Run on separate
    └─────────┘         └─────────┘    servers/machines
```

---

## 🛠️ **Implementation Priority**

| Priority | Task | Impact | Effort |
|----------|------|--------|--------|
| 🔴 P0 | Add Redis state persistence | Prevents data loss | 2-3 days |
| 🔴 P0 | Implement worker queue (BullMQ) | Enables scaling | 3-5 days |
| 🟡 P1 | Add Prometheus metrics | Monitoring | 1-2 days |
| 🟡 P1 | Resource limits per stream | Prevents overload | 1 day |
| 🟢 P2 | Hardware encoding (GPU) | 10x throughput | 2-3 days |
| 🟢 P2 | CDN integration for HLS | Global reach | 3-5 days |

---

## 📈 **Performance Targets**

| Metric | Current (Single Server) | After Queue | After GPU |
|--------|-------------------------|-------------|-----------|
| Max concurrent streams | 2-3 (720p) | 10-15 | 50-100 |
| API response time | 200ms-2s | <100ms | <100ms |
| Stream startup time | 5-10s | 5-10s | 2-5s |
| CPU per stream | 50-80% | 50-80% | 5-10% |

---

## 🚨 **Quick Wins Already Implemented**

✅ **Async I/O** - No more blocking file operations
✅ **Secure paths** - Channel ID instead of user-controlled stream_key
✅ **Dynamic threading** - 1-2 threads per stream based on resolution
✅ **5-min HLS cleanup delay** - Prevents breaking active viewers
✅ **Rotating logs** - 10MB rotation, gzip compression

---

## 📚 **Additional Resources**

- [BullMQ Documentation](https://docs.bullmq.io/)
- [Redis Best Practices](https://redis.io/docs/manual/patterns/)
- [FFmpeg Hardware Acceleration](https://trac.ffmpeg.org/wiki/HWAccelIntro)
- [NGINX RTMP Module](https://github.com/arut/nginx-rtmp-module)
- [SRS (Simple Realtime Server)](https://github.com/ossrs/srs)

---

## 💡 **Cost Estimates (AWS)**

### Current Setup (Single t3.medium)
- **Server**: $30/month
- **Max streams**: 2-3
- **Cost per stream**: $10-15/month

### Scaled Setup (100 concurrent streams)
- **API servers** (2x t3.small): $30/month
- **Workers** (5x c5.2xlarge): $500/month
- **Redis** (cache.m5.large): $150/month
- **S3/CloudFront**: $50/month
- **Total**: $730/month = **$7.30 per stream**

### With GPU (g4dn.xlarge)
- **API servers**: $30/month
- **GPU workers** (2x g4dn.xlarge): $500/month
- **Redis**: $150/month
- **CDN**: $50/month
- **Total**: $730/month for 100+ streams = **<$7 per stream**

---

**Author**: Claude Sonnet 4.5
**Date**: 2026-01-09
**Version**: 1.0
