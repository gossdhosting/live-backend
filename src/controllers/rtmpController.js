import RtmpDestination from '../models/rtmpDestination.js';
import Channel from '../models/Channel.js';
import logger from '../utils/logger.js';

export const getRtmpDestinations = async (req, res) => {
  try {
    const { channelId } = req.params;

    // Verify channel exists
    const channel = Channel.getById(channelId);
    if (!channel) {
      return res.status(404).json({ error: 'Channel not found' });
    }

    const destinations = RtmpDestination.getAll(channelId);
    res.json({ destinations });
  } catch (error) {
    logger.error('Failed to fetch RTMP destinations', { error: error.message });
    res.status(500).json({ error: 'Failed to fetch RTMP destinations' });
  }
};

export const createRtmpDestination = async (req, res) => {
  try {
    const { channelId } = req.params;
    const { platform, rtmp_url, stream_key, enabled } = req.body;

    // Validate required fields
    if (!platform || !rtmp_url || !stream_key) {
      return res.status(400).json({ error: 'Platform, RTMP URL, and stream key are required' });
    }

    // Verify channel exists
    const channel = Channel.getById(channelId);
    if (!channel) {
      return res.status(404).json({ error: 'Channel not found' });
    }

    // Validate platform
    const validPlatforms = ['facebook', 'youtube', 'custom'];
    if (!validPlatforms.includes(platform.toLowerCase())) {
      return res.status(400).json({ error: 'Invalid platform. Must be facebook, youtube, or custom' });
    }

    const destination = RtmpDestination.create({
      channel_id: channelId,
      platform: platform.toLowerCase(),
      rtmp_url,
      stream_key,
      enabled: enabled !== undefined ? enabled : 1,
    });

    logger.info(`RTMP destination created for channel ${channelId}`, { platform, id: destination.id });
    res.status(201).json({ destination });
  } catch (error) {
    logger.error('Failed to create RTMP destination', { error: error.message });
    res.status(500).json({ error: 'Failed to create RTMP destination' });
  }
};

export const updateRtmpDestination = async (req, res) => {
  try {
    const { id } = req.params;
    const { platform, rtmp_url, stream_key, enabled } = req.body;

    // Check if destination exists
    const existing = RtmpDestination.getById(id);
    if (!existing) {
      return res.status(404).json({ error: 'RTMP destination not found' });
    }

    // Validate platform if provided
    if (platform) {
      const validPlatforms = ['facebook', 'youtube', 'custom'];
      if (!validPlatforms.includes(platform.toLowerCase())) {
        return res.status(400).json({ error: 'Invalid platform. Must be facebook, youtube, or custom' });
      }
    }

    const destination = RtmpDestination.update(id, {
      platform: platform?.toLowerCase(),
      rtmp_url,
      stream_key,
      enabled,
    });

    logger.info(`RTMP destination updated`, { id, platform });
    res.json({ destination });
  } catch (error) {
    logger.error('Failed to update RTMP destination', { error: error.message });
    res.status(500).json({ error: 'Failed to update RTMP destination' });
  }
};

export const deleteRtmpDestination = async (req, res) => {
  try {
    const { id } = req.params;

    // Check if destination exists
    const existing = RtmpDestination.getById(id);
    if (!existing) {
      return res.status(404).json({ error: 'RTMP destination not found' });
    }

    RtmpDestination.delete(id);
    logger.info(`RTMP destination deleted`, { id });
    res.json({ message: 'RTMP destination deleted successfully' });
  } catch (error) {
    logger.error('Failed to delete RTMP destination', { error: error.message });
    res.status(500).json({ error: 'Failed to delete RTMP destination' });
  }
};
