import Redis from 'ioredis';
import logger from '../utils/logger.js';

class StateManager {
  constructor() {
    this.redis = new Redis({
      host: process.env.REDIS_HOST || '127.0.0.1',
      port: process.env.REDIS_PORT || 6379,
      password: process.env.REDIS_PASSWORD || undefined,
      db: process.env.REDIS_DB || 0,
      retryStrategy: (times) => {
        const delay = Math.min(times * 50, 2000);
        return delay;
      }
    });

    this.redis.on('error', (err) => {
      logger.error('Redis connection error:', err);
    });

    this.redis.on('connect', () => {
      logger.info('Redis connected successfully');
    });
  }

  // Port Allocation
  async allocatePort(channelId, port) {
    await this.redis.hset('ports:allocated', channelId.toString(), port.toString());
    await this.redis.sadd('ports:used', port.toString());
    logger.info(`Port ${port} allocated to channel ${channelId}`);
  }

  async releasePort(channelId) {
    const port = await this.redis.hget('ports:allocated', channelId.toString());
    if (port) {
      await this.redis.hdel('ports:allocated', channelId.toString());
      await this.redis.srem('ports:used', port);
      logger.info(`Port ${port} released from channel ${channelId}`);
    }
  }

  async getUsedPorts() {
    const ports = await this.redis.smembers('ports:used');
    return ports.map(p => parseInt(p));
  }

  async getAllocatedPort(channelId) {
    const port = await this.redis.hget('ports:allocated', channelId.toString());
    return port ? parseInt(port) : null;
  }

  // Stream State
  async saveStreamState(channelId, state) {
    const stateData = {
      pid: state.pid?.toString() || '',
      status: state.status || '',
      startTime: state.startTime?.toString() || '',
      qualityPreset: state.qualityPreset || ''
    };

    // Only include outputPath if it exists
    if (state.outputPath) {
      stateData.outputPath = state.outputPath;
    }

    await this.redis.hmset(`stream:${channelId}`, stateData);
    await this.redis.expire(`stream:${channelId}`, 86400); // 24 hour TTL
  }

  async getStreamState(channelId) {
    const state = await this.redis.hgetall(`stream:${channelId}`);
    if (!state || Object.keys(state).length === 0) {
      return null;
    }

    return {
      pid: state.pid ? parseInt(state.pid) : null,
      status: state.status,
      startTime: state.startTime ? parseInt(state.startTime) : null,
      outputPath: state.outputPath,
      qualityPreset: state.qualityPreset
    };
  }

  async deleteStreamState(channelId) {
    await this.redis.del(`stream:${channelId}`);
  }

  async getActiveStreamIds() {
    const keys = await this.redis.keys('stream:*');
    return keys.map(key => key.replace('stream:', ''));
  }

  // WebRTC Session State
  async setWebRTCSession(channelId, session) {
    await this.redis.set(
      `webrtc:${channelId}`,
      JSON.stringify(session),
      'EX',
      3600 // 1 hour TTL
    );
  }

  async getWebRTCSession(channelId) {
    const data = await this.redis.get(`webrtc:${channelId}`);
    return data ? JSON.parse(data) : null;
  }

  async deleteWebRTCSession(channelId) {
    await this.redis.del(`webrtc:${channelId}`);
  }

  // FFmpeg Process Tracking
  async setFFmpegProcess(channelId, processId) {
    await this.redis.hset('ffmpeg:processes', channelId.toString(), processId.toString());
  }

  async getFFmpegProcess(channelId) {
    const pid = await this.redis.hget('ffmpeg:processes', channelId.toString());
    return pid ? parseInt(pid) : null;
  }

  async deleteFFmpegProcess(channelId) {
    await this.redis.hdel('ffmpeg:processes', channelId.toString());
  }

  async getAllFFmpegProcesses() {
    return await this.redis.hgetall('ffmpeg:processes');
  }

  // RTMP Status Tracking
  async setRtmpStatus(channelId, destinationId, status) {
    await this.redis.hset(
      `rtmp:status:${channelId}`,
      destinationId.toString(),
      JSON.stringify(status)
    );
    await this.redis.expire(`rtmp:status:${channelId}`, 86400); // 24 hour TTL
  }

  async getRtmpStatus(channelId, destinationId) {
    const data = await this.redis.hget(`rtmp:status:${channelId}`, destinationId.toString());
    return data ? JSON.parse(data) : null;
  }

  async getAllRtmpStatuses(channelId) {
    const statuses = await this.redis.hgetall(`rtmp:status:${channelId}`);
    const parsed = {};
    for (const [key, value] of Object.entries(statuses)) {
      parsed[key] = JSON.parse(value);
    }
    return parsed;
  }

  async deleteRtmpStatuses(channelId) {
    await this.redis.del(`rtmp:status:${channelId}`);
  }

  // Cleanup orphaned state on startup
  async cleanupOrphanedState() {
    logger.info('Cleaning up orphaned state from Redis...');

    const ffmpegProcesses = await this.getAllFFmpegProcesses();
    for (const [channelId, pid] of Object.entries(ffmpegProcesses)) {
      // Check if process is still running
      try {
        process.kill(parseInt(pid), 0); // Signal 0 checks if process exists
        logger.info(`FFmpeg process ${pid} for channel ${channelId} is still running`);
      } catch (e) {
        // Process doesn't exist, clean up
        logger.warn(`Cleaning up orphaned FFmpeg process for channel ${channelId}, PID ${pid}`);
        await this.deleteFFmpegProcess(channelId);
        await this.releasePort(channelId);
        await this.deleteStreamState(channelId);
        await this.deleteRtmpStatuses(channelId);
      }
    }

    logger.info('Orphaned state cleanup complete');
  }

  // Adopt orphaned streams (from scaling guide)
  async adoptOrphanedStreams() {
    logger.info('Checking for orphaned streams to adopt...');

    const activeStreamIds = await this.getActiveStreamIds();

    for (const channelId of activeStreamIds) {
      const state = await this.getStreamState(channelId);

      if (!state || !state.pid) {
        logger.warn(`Stream state incomplete for channel ${channelId}, cleaning up`);
        await this.deleteStreamState(channelId);
        await this.deleteRtmpStatuses(channelId);
        continue;
      }

      // Check if process actually exists
      try {
        process.kill(state.pid, 0); // Signal 0 checks existence without killing
        // Process exists - it can be adopted by StreamManager
        logger.info(`Found adoptable stream ${channelId} (PID: ${state.pid})`);
      } catch (err) {
        // Process doesn't exist - clean up
        logger.warn(`Cleaned up stale stream state ${channelId} (PID: ${state.pid} not found)`);
        await this.deleteStreamState(channelId);
        await this.deleteFFmpegProcess(channelId);
        await this.releasePort(channelId);
        await this.deleteRtmpStatuses(channelId);
      }
    }

    logger.info('Orphaned stream adoption check complete');
  }

  // Graceful shutdown
  async disconnect() {
    await this.redis.quit();
  }
}

export default new StateManager();
