import RtmpDestination from '../models/RtmpDestination.js';
import RtmpTemplate from '../models/RtmpTemplate.js';
import Channel from '../models/Channel.js';
import logger from '../utils/logger.js';

export const getRtmpDestinations = async (req, res) => {
  try {
    const { channelId } = req.params;

    // Verify channel exists
    const channel = Channel.findById(channelId);
    if (!channel) {
      return res.status(404).json({ error: 'Channel not found' });
    }

    // Check ownership (admins can view all, users only their own)
    if (req.user.role !== 'admin' && channel.user_id !== req.user.id) {
      return res.status(403).json({ error: 'Access denied' });
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
    const { platform, rtmp_url, stream_key, enabled, custom_bitrate } = req.body;

    // Validate required fields
    if (!platform || !rtmp_url || !stream_key) {
      return res.status(400).json({ error: 'Platform, RTMP URL, and stream key are required' });
    }

    // Verify channel exists
    const channel = Channel.findById(channelId);
    if (!channel) {
      return res.status(404).json({ error: 'Channel not found' });
    }

    // Check ownership (admins can modify all, users only their own)
    if (req.user.role !== 'admin' && channel.user_id !== req.user.id) {
      return res.status(403).json({ error: 'Access denied' });
    }

    // Validate platform
    const validPlatforms = ['facebook', 'youtube', 'twitch', 'custom'];
    if (!validPlatforms.includes(platform.toLowerCase())) {
      return res.status(400).json({ error: 'Invalid platform. Must be facebook, youtube, twitch, or custom' });
    }

    const destination = RtmpDestination.create({
      channel_id: channelId,
      platform: platform.toLowerCase(),
      rtmp_url,
      stream_key,
      enabled: enabled !== undefined ? (enabled ? 1 : 0) : 1,
      custom_bitrate: custom_bitrate || null,
    });

    logger.info(`RTMP destination created for channel ${channelId}`, { platform, id: destination.id, custom_bitrate });
    res.status(201).json({ destination });
  } catch (error) {
    logger.error('Failed to create RTMP destination', { error: error.message });
    res.status(500).json({ error: 'Failed to create RTMP destination' });
  }
};

export const updateRtmpDestination = async (req, res) => {
  try {
    const { id } = req.params;
    const { platform, rtmp_url, stream_key, enabled, custom_bitrate } = req.body;

    // Check if destination exists
    const existing = RtmpDestination.getById(id);
    if (!existing) {
      return res.status(404).json({ error: 'RTMP destination not found' });
    }

    // Check ownership via channel
    const channel = Channel.findById(existing.channel_id);
    if (channel && req.user.role !== 'admin' && channel.user_id !== req.user.id) {
      return res.status(403).json({ error: 'Access denied' });
    }

    // Validate platform if provided
    if (platform) {
      const validPlatforms = ['facebook', 'youtube', 'twitch', 'custom'];
      if (!validPlatforms.includes(platform.toLowerCase())) {
        return res.status(400).json({ error: 'Invalid platform. Must be facebook, youtube, twitch, or custom' });
      }
    }

    const destination = RtmpDestination.update(id, {
      platform: platform?.toLowerCase(),
      rtmp_url,
      stream_key,
      enabled: enabled !== undefined ? (enabled ? 1 : 0) : undefined,
      custom_bitrate: custom_bitrate !== undefined ? custom_bitrate : undefined,
    });

    logger.info(`RTMP destination updated`, { id, platform, custom_bitrate });
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

    // Check ownership via channel
    const channel = Channel.findById(existing.channel_id);
    if (channel && req.user.role !== 'admin' && channel.user_id !== req.user.id) {
      return res.status(403).json({ error: 'Access denied' });
    }

    RtmpDestination.delete(id);
    logger.info(`RTMP destination deleted`, { id });
    res.json({ message: 'RTMP destination deleted successfully' });
  } catch (error) {
    logger.error('Failed to delete RTMP destination', { error: error.message });
    res.status(500).json({ error: 'Failed to delete RTMP destination' });
  }
};

// Toggle a template for a specific channel (enable/disable)
export const toggleTemplateForChannel = async (req, res) => {
  try {
    const { channelId, templateId } = req.params;
    const { enabled } = req.body;

    // Verify channel exists
    const channel = Channel.findById(channelId);
    if (!channel) {
      return res.status(404).json({ error: 'Channel not found' });
    }

    // Check ownership (admins can modify all, users only their own)
    if (req.user.role !== 'admin' && channel.user_id !== req.user.id) {
      return res.status(403).json({ error: 'Access denied' });
    }

    // Verify template exists
    const template = RtmpTemplate.getById(templateId);
    if (!template) {
      return res.status(404).json({ error: 'Template not found' });
    }

    // Check if destination already exists for this channel+template
    const existingDestination = RtmpDestination.getByChannelAndTemplate(channelId, templateId);

    if (enabled) {
      // Enable: create or update destination
      if (existingDestination) {
        const destination = RtmpDestination.update(existingDestination.id, { enabled: 1 });
        logger.info(`RTMP destination enabled for channel ${channelId}`, { templateId });
        return res.json({ destination });
      } else {
        const destination = RtmpDestination.create({
          channel_id: channelId,
          template_id: templateId,
          platform: template.platform,
          rtmp_url: template.rtmp_url,
          stream_key: template.stream_key,
          enabled: 1,
        });
        logger.info(`RTMP destination created from template for channel ${channelId}`, { templateId });
        return res.status(201).json({ destination });
      }
    } else {
      // Disable: delete destination if exists
      if (existingDestination) {
        RtmpDestination.delete(existingDestination.id);
        logger.info(`RTMP destination disabled for channel ${channelId}`, { templateId });
        return res.json({ message: 'Destination disabled' });
      }
      return res.json({ message: 'Destination already disabled' });
    }
  } catch (error) {
    logger.error('Failed to toggle template for channel', { error: error.message });
    res.status(500).json({ error: 'Failed to toggle template for channel' });
  }
};
