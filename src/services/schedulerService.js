import ScheduledStream from '../models/ScheduledStream.js';
import Channel from '../models/Channel.js';
import User from '../models/User.js';
import streamManager from '../ffmpeg/StreamManager.js';
import logger from '../utils/logger.js';

class SchedulerService {
  constructor() {
    this.checkInterval = null;
    this.isRunning = false;
    this.CHECK_FREQUENCY = 30000; // Check every 30 seconds
  }

  // Start the scheduler service
  start() {
    if (this.isRunning) {
      logger.warn('Scheduler service is already running');
      return;
    }

    logger.info('🕐 Starting scheduler service...');
    this.isRunning = true;

    // Run initial check immediately
    this.checkScheduledStreams();

    // Set up periodic checks
    this.checkInterval = setInterval(() => {
      this.checkScheduledStreams();
    }, this.CHECK_FREQUENCY);

    logger.info(`✅ Scheduler service started (checking every ${this.CHECK_FREQUENCY / 1000}s)`);
  }

  // Stop the scheduler service
  stop() {
    if (!this.isRunning) {
      return;
    }

    logger.info('Stopping scheduler service...');
    if (this.checkInterval) {
      clearInterval(this.checkInterval);
      this.checkInterval = null;
    }
    this.isRunning = false;
    logger.info('✅ Scheduler service stopped');
  }

  // Check for scheduled streams that need to start
  async checkScheduledStreams() {
    try {
      // Get all pending scheduled streams that are due
      const dueStreams = await ScheduledStream.getPendingDue();

      if (dueStreams.length === 0) {
        return; // No streams to process
      }

      logger.info(`Found ${dueStreams.length} scheduled stream(s) ready to start`);

      for (const schedule of dueStreams) {
        await this.startScheduledStream(schedule);
      }
    } catch (error) {
      logger.error('Error checking scheduled streams', { error: error.message, stack: error.stack });
    }
  }

  // Start a specific scheduled stream
  async startScheduledStream(schedule) {
    const { id, channel_id, user_id, channel_name, channel_status, timezone } = schedule;

    try {
      logger.info(`Starting scheduled stream`, {
        scheduleId: id,
        channelId: channel_id,
        channelName: channel_name,
        timezone: timezone
      });

      // Check if channel exists
      const channel = await Channel.findById(channel_id);
      if (!channel) {
        logger.error(`Channel not found for scheduled stream`, { scheduleId: id, channelId: channel_id });
        await ScheduledStream.updateStatus(id, 'failed', 'Channel not found');
        return;
      }

      // Check if channel is already running
      if (channel.status === 'running') {
        logger.warn(`Channel already running for scheduled stream`, { scheduleId: id, channelId: channel_id });
        await ScheduledStream.updateStatus(id, 'completed', 'Channel was already running');
        return;
      }

      // Get user for plan limit checking
      const user = await User.findById(user_id);
      if (!user) {
        logger.error(`User not found for scheduled stream`, { scheduleId: id, userId: user_id });
        await ScheduledStream.updateStatus(id, 'failed', 'User not found');
        return;
      }

      // Check if user has schedule_enabled feature
      const planLimits = await User.checkPlanLimits(user_id);
      if (!planLimits || !planLimits.limits.schedule_enabled) {
        logger.error(`User does not have scheduling feature`, { scheduleId: id, userId: user_id });
        await ScheduledStream.updateStatus(id, 'failed', 'Scheduling feature not enabled in plan');
        return;
      }

      // Start the stream using StreamManager
      await streamManager.startStream(channel_id, user);

      // Update schedule status to started
      await ScheduledStream.updateStatus(id, 'started');

      logger.info(`✅ Successfully started scheduled stream`, {
        scheduleId: id,
        channelId: channel_id,
        channelName: channel_name
      });

    } catch (error) {
      logger.error(`Failed to start scheduled stream`, {
        scheduleId: id,
        channelId: channel_id,
        error: error.message,
        stack: error.stack
      });

      // Update schedule status to failed
      await ScheduledStream.updateStatus(id, 'failed', error.message);
    }
  }

  // Manually trigger a scheduled stream (for testing)
  async triggerSchedule(scheduleId) {
    const schedule = await ScheduledStream.getById(scheduleId);
    if (!schedule) {
      throw new Error('Scheduled stream not found');
    }

    if (schedule.status !== 'pending') {
      throw new Error(`Cannot trigger schedule with status: ${schedule.status}`);
    }

    await this.startScheduledStream(schedule);
  }

  // Get scheduler status
  getStatus() {
    return {
      running: this.isRunning,
      checkFrequency: this.CHECK_FREQUENCY,
      nextCheckIn: this.checkInterval ? this.CHECK_FREQUENCY : null
    };
  }

  // Run cleanup job (delete old completed/cancelled/failed schedules)
  async runCleanup() {
    try {
      logger.info('Running scheduled streams cleanup...');
      const result = await ScheduledStream.cleanup();
      logger.info(`✅ Cleanup completed`, { deletedCount: result.changes });
      return result;
    } catch (error) {
      logger.error('Cleanup failed', { error: error.message });
      throw error;
    }
  }
}

// Export singleton instance
const schedulerService = new SchedulerService();
export default schedulerService;
