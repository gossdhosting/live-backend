import ScheduledStream from '../models/ScheduledStream.js';
import Channel from '../models/Channel.js';
import User from '../models/User.js';
import logger from '../utils/logger.js';

// Get all scheduled streams for the authenticated user
export const getUserScheduledStreams = async (req, res) => {
  try {
    const userId = req.user.id;
    const schedules = await ScheduledStream.getByUserId(userId);
    res.json({ schedules });
  } catch (error) {
    logger.error('Get user scheduled streams error', { error: error.message });
    res.status(500).json({ error: 'Internal server error' });
  }
};

// Get all scheduled streams (admin only)
export const getAllScheduledStreams = async (req, res) => {
  try {
    const schedules = await ScheduledStream.getAll();
    res.json({ schedules });
  } catch (error) {
    logger.error('Get all scheduled streams error', { error: error.message });
    res.status(500).json({ error: 'Internal server error' });
  }
};

// Get scheduled streams for a specific channel
export const getChannelScheduledStreams = async (req, res) => {
  try {
    const { channelId } = req.params;

    // Get channel and verify ownership
    const channel = await Channel.findById(channelId);
    if (!channel) {
      return res.status(404).json({ error: 'Channel not found' });
    }

    // Check ownership (admin or channel owner)
    if (req.user.role !== 'admin' && channel.user_id !== req.user.id) {
      return res.status(403).json({ error: 'Access denied' });
    }

    const schedules = await ScheduledStream.getByChannelId(channelId);
    res.json({ schedules });
  } catch (error) {
    logger.error('Get channel scheduled streams error', { error: error.message });
    res.status(500).json({ error: 'Internal server error' });
  }
};

// Get active scheduled stream for a channel
export const getActiveSchedule = async (req, res) => {
  try {
    const { channelId } = req.params;

    // Get channel and verify ownership
    const channel = await Channel.findById(channelId);
    if (!channel) {
      return res.status(404).json({ error: 'Channel not found' });
    }

    // Check ownership (admin or channel owner)
    if (req.user.role !== 'admin' && channel.user_id !== req.user.id) {
      return res.status(403).json({ error: 'Access denied' });
    }

    const schedule = await ScheduledStream.getActiveByChannelId(channelId);
    res.json({ schedule: schedule || null });
  } catch (error) {
    logger.error('Get active schedule error', { error: error.message });
    res.status(500).json({ error: 'Internal server error' });
  }
};

// Create a new scheduled stream
export const createScheduledStream = async (req, res) => {
  try {
    const { channel_id, scheduled_start_time, timezone } = req.body;

    // Validate required fields
    if (!channel_id || !scheduled_start_time || !timezone) {
      return res.status(400).json({
        error: 'Missing required fields: channel_id, scheduled_start_time, timezone'
      });
    }

    // Get channel and verify ownership
    const channel = await Channel.findById(channel_id);
    if (!channel) {
      return res.status(404).json({ error: 'Channel not found' });
    }

    // Check ownership (admin or channel owner)
    if (req.user.role !== 'admin' && channel.user_id !== req.user.id) {
      return res.status(403).json({ error: 'Access denied' });
    }

    // Check if user has schedule_enabled feature
    const planLimits = await User.checkPlanLimits(req.user.id);
    if (!planLimits || !planLimits.limits.schedule_enabled) {
      return res.status(403).json({
        error: 'Scheduling feature not available in your plan. Please upgrade to access this feature.'
      });
    }

    // Check if channel already has a pending scheduled stream
    const existingSchedule = await ScheduledStream.getActiveByChannelId(channel_id);
    if (existingSchedule) {
      return res.status(400).json({
        error: 'Channel already has a pending scheduled stream. Cancel it first to create a new one.'
      });
    }

    // Validate scheduled time is in the future
    const scheduledTime = new Date(scheduled_start_time);
    if (scheduledTime <= new Date()) {
      return res.status(400).json({
        error: 'Scheduled time must be in the future'
      });
    }

    // Create the scheduled stream
    const schedule = await ScheduledStream.create({
      channel_id,
      user_id: req.user.id,
      scheduled_start_time,
      timezone
    });

    logger.info('Scheduled stream created', {
      scheduleId: schedule.id,
      channelId: channel_id,
      userId: req.user.id,
      scheduledTime: scheduled_start_time,
      timezone
    });

    res.status(201).json({ schedule });
  } catch (error) {
    logger.error('Create scheduled stream error', { error: error.message, stack: error.stack });
    res.status(500).json({ error: 'Internal server error' });
  }
};

// Update scheduled stream time
export const updateScheduledStream = async (req, res) => {
  try {
    const { id } = req.params;
    const { scheduled_start_time, timezone } = req.body;

    // Get scheduled stream
    const schedule = await ScheduledStream.getById(id);
    if (!schedule) {
      return res.status(404).json({ error: 'Scheduled stream not found' });
    }

    // Verify ownership
    if (req.user.role !== 'admin' && schedule.user_id !== req.user.id) {
      return res.status(403).json({ error: 'Access denied' });
    }

    // Can only update pending schedules
    if (schedule.status !== 'pending') {
      return res.status(400).json({
        error: `Cannot update schedule with status: ${schedule.status}`
      });
    }

    // Validate scheduled time is in the future
    if (scheduled_start_time) {
      const scheduledTime = new Date(scheduled_start_time);
      if (scheduledTime <= new Date()) {
        return res.status(400).json({
          error: 'Scheduled time must be in the future'
        });
      }
    }

    // Update the schedule
    const updated = await ScheduledStream.updateScheduledTime(
      id,
      scheduled_start_time || schedule.scheduled_start_time,
      timezone || schedule.timezone
    );

    logger.info('Scheduled stream updated', {
      scheduleId: id,
      userId: req.user.id,
      newTime: scheduled_start_time,
      newTimezone: timezone
    });

    res.json({ schedule: updated });
  } catch (error) {
    logger.error('Update scheduled stream error', { error: error.message });
    res.status(500).json({ error: 'Internal server error' });
  }
};

// Cancel a scheduled stream
export const cancelScheduledStream = async (req, res) => {
  try {
    const { id } = req.params;

    // Get scheduled stream
    const schedule = await ScheduledStream.getById(id);
    if (!schedule) {
      return res.status(404).json({ error: 'Scheduled stream not found' });
    }

    // Verify ownership
    if (req.user.role !== 'admin' && schedule.user_id !== req.user.id) {
      return res.status(403).json({ error: 'Access denied' });
    }

    // Can only cancel pending schedules
    if (schedule.status !== 'pending') {
      return res.status(400).json({
        error: `Cannot cancel schedule with status: ${schedule.status}`
      });
    }

    // Cancel the schedule
    const cancelled = await ScheduledStream.cancel(id);

    logger.info('Scheduled stream cancelled', {
      scheduleId: id,
      userId: req.user.id
    });

    res.json({ schedule: cancelled });
  } catch (error) {
    logger.error('Cancel scheduled stream error', { error: error.message });
    res.status(500).json({ error: 'Internal server error' });
  }
};

// Delete a scheduled stream
export const deleteScheduledStream = async (req, res) => {
  try {
    const { id } = req.params;

    // Get scheduled stream
    const schedule = await ScheduledStream.getById(id);
    if (!schedule) {
      return res.status(404).json({ error: 'Scheduled stream not found' });
    }

    // Verify ownership
    if (req.user.role !== 'admin' && schedule.user_id !== req.user.id) {
      return res.status(403).json({ error: 'Access denied' });
    }

    // Delete the schedule
    await ScheduledStream.delete(id);

    logger.info('Scheduled stream deleted', {
      scheduleId: id,
      userId: req.user.id
    });

    res.json({ message: 'Scheduled stream deleted successfully' });
  } catch (error) {
    logger.error('Delete scheduled stream error', { error: error.message });
    res.status(500).json({ error: 'Internal server error' });
  }
};
