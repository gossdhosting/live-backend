import RtmpTemplate from '../models/RtmpTemplate.js';
import logger from '../utils/logger.js';

export const getRtmpTemplates = async (req, res) => {
  try {
    // Check if we should only return enabled templates
    const enabledOnly = req.query.enabled === 'true';
    const templates = enabledOnly ? await RtmpTemplate.getEnabled() : await RtmpTemplate.getAll();

    // Filter to only return custom platform templates (exclude facebook, youtube, twitch)
    const customTemplates = templates.filter(t => t.platform === 'custom');

    res.json({ templates: customTemplates });
  } catch (error) {
    logger.error('Failed to fetch RTMP templates', { error: error.message, stack: error.stack });
    console.error('RTMP templates error:', error);
    res.status(500).json({ error: 'Failed to fetch RTMP templates' });
  }
};

export const createRtmpTemplate = async (req, res) => {
  try {
    const { name, platform, rtmp_url, stream_key, video_orientation = '16:9' } = req.body;

    // Validate required fields
    if (!name || !platform || !rtmp_url || !stream_key) {
      return res.status(400).json({ error: 'Name, platform, RTMP URL, and stream key are required' });
    }

    // Validate platform
    const validPlatforms = ['facebook', 'youtube', 'twitch', 'custom'];
    if (!validPlatforms.includes(platform.toLowerCase())) {
      return res.status(400).json({ error: 'Invalid platform. Must be facebook, youtube, twitch, or custom' });
    }

    // Validate video_orientation
    const validOrientations = ['16:9', '9:16'];
    if (!validOrientations.includes(video_orientation)) {
      return res.status(400).json({ error: 'Invalid video orientation. Must be 16:9 or 9:16' });
    }

    const template = await RtmpTemplate.create({
      name,
      platform: platform.toLowerCase(),
      rtmp_url,
      stream_key,
      video_orientation,
    });

    logger.info(`RTMP template created`, { name, platform, video_orientation, id: template.id });
    res.status(201).json({ template });
  } catch (error) {
    logger.error('Failed to create RTMP template', { error: error.message });
    res.status(500).json({ error: 'Failed to create RTMP template' });
  }
};

export const updateRtmpTemplate = async (req, res) => {
  try {
    const { id } = req.params;
    const { name, platform, rtmp_url, stream_key, video_orientation, enabled } = req.body;

    // Check if template exists
    const existing = await RtmpTemplate.getById(id);
    if (!existing) {
      return res.status(404).json({ error: 'RTMP template not found' });
    }

    // Validate platform if provided
    if (platform) {
      const validPlatforms = ['facebook', 'youtube', 'twitch', 'custom'];
      if (!validPlatforms.includes(platform.toLowerCase())) {
        return res.status(400).json({ error: 'Invalid platform. Must be facebook, youtube, twitch, or custom' });
      }
    }

    // Validate video_orientation if provided
    if (video_orientation !== undefined) {
      const validOrientations = ['16:9', '9:16'];
      if (!validOrientations.includes(video_orientation)) {
        return res.status(400).json({ error: 'Invalid video orientation. Must be 16:9 or 9:16' });
      }
    }

    const template = await RtmpTemplate.update(id, {
      name,
      platform: platform?.toLowerCase(),
      rtmp_url,
      stream_key,
      video_orientation,
      enabled,
    });

    logger.info(`RTMP template updated`, { id, name, platform, video_orientation, enabled });
    res.json({ template });
  } catch (error) {
    logger.error('Failed to update RTMP template', { error: error.message });
    res.status(500).json({ error: 'Failed to update RTMP template' });
  }
};

export const deleteRtmpTemplate = async (req, res) => {
  try {
    const { id } = req.params;

    // Check if template exists
    const existing = await RtmpTemplate.getById(id);
    if (!existing) {
      return res.status(404).json({ error: 'RTMP template not found' });
    }

    await RtmpTemplate.delete(id);
    logger.info(`RTMP template deleted`, { id });
    res.json({ message: 'RTMP template deleted successfully' });
  } catch (error) {
    logger.error('Failed to delete RTMP template', { error: error.message });
    res.status(500).json({ error: 'Failed to delete RTMP template' });
  }
};
