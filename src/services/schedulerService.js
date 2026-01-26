import ScheduledStream from '../models/ScheduledStream.js';
import Channel from '../models/Channel.js';
import User from '../models/User.js';
import streamManager from '../ffmpeg/StreamManager.js';
import logger from '../utils/logger.js';
import OneSignalService from './OneSignalService.js';

class SchedulerService {
  constructor() {
    this.checkInterval = null;
    this.isRunning = false;
    this.CHECK_FREQUENCY = 30000; // Check every 30 seconds
    this.notifiedSchedules = new Set(); // Track which schedules have been notified
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

    // Check for upcoming streams that need notification
    try {
      await this.checkUpcomingStreams();
    } catch (error) {
      logger.error('Error checking upcoming streams', { error: error.message });
    }
  }

  // Check for upcoming scheduled streams and send notifications
  async checkUpcomingStreams() {
    try {
      const db = (await import('../models/database.js')).default;
      const now = new Date();
      const fifteenMinutesLater = new Date(now.getTime() + 15 * 60 * 1000);

      // Get pending scheduled streams starting in the next 15 minutes
      const stmt = db.prepare(`
        SELECT ss.*, c.name as channel_name
        FROM scheduled_streams ss
        JOIN channels c ON ss.channel_id = c.id
        WHERE ss.status = 'pending'
        AND datetime(ss.scheduled_at) > datetime('now')
        AND datetime(ss.scheduled_at) <= datetime('now', '+15 minutes')
      `);

      const upcomingStreams = await stmt.all();

      for (const schedule of upcomingStreams) {
        // Skip if already notified
        if (this.notifiedSchedules.has(schedule.id)) {
          continue;
        }

        const scheduledTime = new Date(schedule.scheduled_at);
        const minutesUntilStart = Math.round((scheduledTime - now) / (1000 * 60));

        // Only notify for 5 and 15 minute marks
        if (minutesUntilStart === 5 || minutesUntilStart === 15) {
          try {
            const playerId = await User.getOneSignalPlayerId(schedule.user_id);
            if (playerId) {
              await OneSignalService.notifyScheduledStreamStarting(
                playerId,
                schedule.channel_name,
                minutesUntilStart
              );
              this.notifiedSchedules.add(schedule.id);
              logger.info(`Sent notification for scheduled stream`, {
                scheduleId: schedule.id,
                minutesUntilStart
              });
            }
          } catch (notifError) {
            logger.error('Failed to send scheduled stream notification', { error: notifError.message });
          }
        }
      }
    } catch (error) {
      logger.error('Error in checkUpcomingStreams', { error: error.message });
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
