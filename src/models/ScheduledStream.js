import db from './database.js';

class ScheduledStream {
  // Helper to normalize scheduled_start_time to ISO format with 'Z' suffix
  static normalizeSchedule(schedule) {
    if (!schedule) return schedule;
    if (schedule.scheduled_start_time) {
      // Ensure the time is in ISO format with Z suffix for UTC
      const time = schedule.scheduled_start_time;
      if (typeof time === 'string' && !time.endsWith('Z') && !time.includes('+')) {
        // Convert "2026-01-18 16:09:00" to "2026-01-18T16:09:00.000Z"
        schedule.scheduled_start_time = time.replace(' ', 'T') + '.000Z';
      }
    }
    return schedule;
  }

  // Helper to normalize an array of schedules
  static normalizeSchedules(schedules) {
    if (!Array.isArray(schedules)) return schedules;
    return schedules.map(s => this.normalizeSchedule(s));
  }

  // Get all scheduled streams (admin only)
  static async getAll() {
    const stmt = db.prepare(`
      SELECT
        ss.*,
        c.name as channel_name,
        u.email as user_email,
        u.name as user_name
      FROM scheduled_streams ss
      JOIN channels c ON ss.channel_id = c.id
      JOIN users u ON ss.user_id = u.id
      ORDER BY ss.scheduled_start_time ASC
    `);
    const results = await stmt.all();
    return this.normalizeSchedules(results);
  }

  // Get scheduled streams by user ID
  static async getByUserId(userId) {
    const stmt = db.prepare(`
      SELECT
        ss.*,
        c.name as channel_name,
        c.status as channel_status
      FROM scheduled_streams ss
      JOIN channels c ON ss.channel_id = c.id
      WHERE ss.user_id = ?
      ORDER BY ss.scheduled_start_time ASC
    `);
    const results = await stmt.all(userId);
    return this.normalizeSchedules(results);
  }

  // Get scheduled streams by channel ID
  static async getByChannelId(channelId) {
    const stmt = db.prepare('SELECT * FROM scheduled_streams WHERE channel_id = ? ORDER BY scheduled_start_time ASC');
    const results = await stmt.all(channelId);
    return this.normalizeSchedules(results);
  }

  // Get active (pending) scheduled stream for a channel
  static async getActiveByChannelId(channelId) {
    const stmt = db.prepare(`
      SELECT * FROM scheduled_streams
      WHERE channel_id = ? AND status = 'pending'
      ORDER BY scheduled_start_time ASC
      LIMIT 1
    `);
    const result = await stmt.get(channelId);
    return this.normalizeSchedule(result);
  }

  // Get scheduled stream by ID
  static async getById(id) {
    const stmt = db.prepare('SELECT * FROM scheduled_streams WHERE id = ?');
    const result = await stmt.get(id);
    return this.normalizeSchedule(result);
  }

  // Get all pending scheduled streams that should start now
  static async getPendingDue() {
    const stmt = db.prepare(`
      SELECT
        ss.*,
        c.name as channel_name,
        c.status as channel_status,
        c.user_id as channel_user_id,
        CURRENT_TIMESTAMP as db_current_time
      FROM scheduled_streams ss
      JOIN channels c ON ss.channel_id = c.id
      WHERE ss.status = 'pending'
      AND ss.scheduled_start_time <= CURRENT_TIMESTAMP
      ORDER BY ss.scheduled_start_time ASC
    `);
    const results = await stmt.all();

    // Debug logging to help diagnose timezone issues
    if (results.length > 0) {
      const now = new Date().toISOString();
      results.forEach(schedule => {
        console.log('⏰ Scheduled stream due check:', {
          scheduleId: schedule.id,
          channelName: schedule.channel_name,
          scheduledTime: schedule.scheduled_start_time,
          timezone: schedule.timezone,
          dbCurrentTime: schedule.db_current_time,
          nodeCurrentTime: now,
          isDue: new Date(schedule.scheduled_start_time) <= new Date()
        });
      });
    }

    return results;
  }

  // Create new scheduled stream
  static async create(data) {
    const stmt = db.prepare(`
      INSERT INTO scheduled_streams (
        channel_id,
        user_id,
        scheduled_start_time,
        timezone
      )
      VALUES (?, ?, ?, ?)
    `);

    const result = await stmt.run(
      data.channel_id,
      data.user_id,
      data.scheduled_start_time,
      data.timezone || 'UTC'
    );

    return await this.getById(result.lastInsertRowid || result.lastID);
  }

  // Update scheduled stream status
  static async updateStatus(id, status, errorMessage = null) {
    const updates = ['status = ?'];
    const values = [status];

    if (status === 'started') {
      updates.push('started_at = CURRENT_TIMESTAMP');
    } else if (status === 'cancelled') {
      updates.push('cancelled_at = CURRENT_TIMESTAMP');
    }

    if (errorMessage) {
      updates.push('error_message = ?');
      values.push(errorMessage);
    }

    values.push(id);

    const stmt = db.prepare(`
      UPDATE scheduled_streams
      SET ${updates.join(', ')}, updated_at = CURRENT_TIMESTAMP
      WHERE id = ?
    `);

    await stmt.run(...values);
    return await this.getById(id);
  }

  // Update scheduled stream time
  static async updateScheduledTime(id, scheduledStartTime, timezone) {
    const stmt = db.prepare(`
      UPDATE scheduled_streams
      SET scheduled_start_time = ?, timezone = ?, updated_at = CURRENT_TIMESTAMP
      WHERE id = ?
    `);

    await stmt.run(scheduledStartTime, timezone, id);
    return await this.getById(id);
  }

  // Cancel scheduled stream
  static async cancel(id) {
    return await this.updateStatus(id, 'cancelled');
  }

  // Delete scheduled stream
  static async delete(id) {
    const stmt = db.prepare('DELETE FROM scheduled_streams WHERE id = ?');
    return await stmt.run(id);
  }

  // Check if channel has pending scheduled stream
  static async hasPendingSchedule(channelId) {
    const stmt = db.prepare(`
      SELECT COUNT(*) as count
      FROM scheduled_streams
      WHERE channel_id = ? AND status = 'pending'
    `);
    const result = await stmt.get(channelId);
    return result.count > 0;
  }

  // Get pending schedule count for user (for plan limit checking)
  static async getPendingCountByUser(userId) {
    const stmt = db.prepare(`
      SELECT COUNT(*) as count
      FROM scheduled_streams
      WHERE user_id = ? AND status = 'pending'
    `);
    const result = await stmt.get(userId);
    return result.count || 0;
  }

  // Clean up old completed/cancelled/failed schedules (older than 30 days)
  static async cleanup() {
    const stmt = db.prepare(`
      DELETE FROM scheduled_streams
      WHERE status IN ('started', 'cancelled', 'failed', 'completed')
      AND updated_at < CURRENT_TIMESTAMP - INTERVAL '30 days'
    `);
    return await stmt.run();
  }
}

export default ScheduledStream;
