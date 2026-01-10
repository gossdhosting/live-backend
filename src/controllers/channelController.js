import Channel from '../models/Channel.js';
import MediaFile from '../models/MediaFile.js';
import User from '../models/User.js';
import streamManager from '../ffmpeg/StreamManager.js';
import { isValidYouTubeUrl, isValidChannelName } from '../utils/validation.js';
import logger from '../utils/logger.js';

// Quality preset to bitrate mapping (kbps)
const QUALITY_BITRATES = {
  '480p': 2500,
  '720p': 4000,
  '1080p': 6000
};

// Get all channels
export const getAllChannels = (req, res) => {
  try {
    // All users (including admins) only see their own channels
    const channels = Channel.findByUserId(req.user.id);

    // Enhance with real-time status
    const enhancedChannels = channels.map((channel) => ({
      ...channel,
      runtime_status: streamManager.getStreamStatus(channel.id),
    }));

    res.json({ channels: enhancedChannels });
  } catch (error) {
    logger.error('Get all channels error', { error: error.message });
    res.status(500).json({ error: 'Internal server error' });
  }
};

// Get single channel
export const getChannel = (req, res) => {
  try {
    const { id } = req.params;
    const channel = Channel.findById(id);

    if (!channel) {
      return res.status(404).json({ error: 'Channel not found' });
    }

    // Check ownership (admins can view all, users only their own)
    if (req.user.role !== 'admin' && channel.user_id !== req.user.id) {
      return res.status(403).json({ error: 'Access denied' });
    }

    const runtimeStatus = streamManager.getStreamStatus(channel.id);

    res.json({
      channel: {
        ...channel,
        runtime_status: runtimeStatus,
      },
    });
  } catch (error) {
    logger.error('Get channel error', { error: error.message });
    res.status(500).json({ error: 'Internal server error' });
  }
};

// Create channel
export const createChannel = async (req, res) => {
  try {
    const {
      name,
      description,
      input_url,
      auto_restart,
      quality_preset,
      stream_title,
      input_type,
      media_file_id,
      loop_video,
      title_enabled
    } = req.body;

    // Validation
    if (!name) {
      return res.status(400).json({ error: 'Channel name is required' });
    }

    if (!isValidChannelName(name)) {
      return res
        .status(400)
        .json({ error: 'Channel name must be 2-100 characters' });
    }

    // Validate based on input type
    const finalInputType = input_type || 'youtube';

    if (finalInputType === 'youtube') {
      if (!input_url) {
        return res.status(400).json({ error: 'YouTube URL is required' });
      }
      if (!isValidYouTubeUrl(input_url)) {
        return res.status(400).json({ error: 'Invalid YouTube URL' });
      }
    } else if (finalInputType === 'video') {
      if (!media_file_id) {
        return res.status(400).json({ error: 'Media file selection is required for video input type' });
      }
      // Verify media file exists
      const mediaFile = MediaFile.findById(media_file_id);
      if (!mediaFile) {
        return res.status(400).json({ error: 'Selected media file not found' });
      }
    } else {
      return res.status(400).json({ error: 'Invalid input type. Must be "youtube" or "video"' });
    }

    // Validate quality preset against plan limits (unless admin)
    if (req.user.role !== 'admin' && quality_preset) {
      const userLimits = await User.checkPlanLimits(req.user.id);
      if (userLimits && userLimits.limits.max_bitrate) {
        const requestedBitrate = QUALITY_BITRATES[quality_preset] || 0;
        if (requestedBitrate > userLimits.limits.max_bitrate) {
          return res.status(403).json({
            error: `Quality preset ${quality_preset} exceeds your plan's bitrate limit`,
            max_bitrate: userLimits.limits.max_bitrate,
            requested_bitrate: requestedBitrate,
            allowed_presets: Object.keys(QUALITY_BITRATES).filter(
              preset => QUALITY_BITRATES[preset] <= userLimits.limits.max_bitrate
            )
          });
        }
      }
    }

    const channel = Channel.create({
      user_id: req.user.id,
      name,
      description,
      input_url: input_url || '',
      auto_restart: auto_restart ? 1 : 0,
      quality_preset,
      stream_title: stream_title || '',
      input_type: finalInputType,
      media_file_id: media_file_id || null,
      loop_video: loop_video ? 1 : 0,
      title_enabled: title_enabled ? 1 : 0,
    });

    logger.info('Channel created', {
      channelId: channel.id,
      name,
      inputType: finalInputType,
      mediaFileId: media_file_id,
      loopVideo: loop_video
    });

    res.status(201).json({ channel });
  } catch (error) {
    logger.error('Create channel error', { error: error.message });
    res.status(500).json({ error: 'Internal server error' });
  }
};

// Update channel
export const updateChannel = (req, res) => {
  try {
    const { id } = req.params;
    const {
      name,
      description,
      input_url,
      auto_restart,
      quality_preset,
      stream_title,
      input_type,
      media_file_id,
      loop_video,
      title_enabled,
      watermark_enabled
    } = req.body;

    logger.info('Update channel request', {
      channelId: id,
      title_enabled,
      stream_title,
      watermark_enabled,
      body: req.body
    });

    const channel = Channel.findById(id);

    if (!channel) {
      return res.status(404).json({ error: 'Channel not found' });
    }

    // Check ownership (admins can update all, users only their own)
    if (req.user.role !== 'admin' && channel.user_id !== req.user.id) {
      return res.status(403).json({ error: 'Access denied' });
    }

    // Note: Frontend handles stopping stream before update if needed
    // Validation
    if (name && !isValidChannelName(name)) {
      return res
        .status(400)
        .json({ error: 'Channel name must be 2-100 characters' });
    }

    if (input_url && !isValidYouTubeUrl(input_url)) {
      return res.status(400).json({ error: 'Invalid YouTube URL' });
    }

    const updateData = {};
    if (name) updateData.name = name;
    if (description !== undefined) updateData.description = description;
    if (input_url !== undefined) updateData.input_url = input_url;
    if (auto_restart !== undefined) updateData.auto_restart = auto_restart ? 1 : 0;
    if (quality_preset) updateData.quality_preset = quality_preset;
    if (stream_title !== undefined) updateData.stream_title = stream_title;
    if (input_type) updateData.input_type = input_type;
    if (media_file_id !== undefined) updateData.media_file_id = media_file_id;
    if (loop_video !== undefined) updateData.loop_video = loop_video ? 1 : 0;
    if (title_enabled !== undefined) updateData.title_enabled = title_enabled ? 1 : 0;
    if (watermark_enabled !== undefined) updateData.watermark_enabled = watermark_enabled ? 1 : 0;

    logger.info('Updating channel with data', { channelId: id, updateData });

    const updatedChannel = Channel.update(id, updateData);

    logger.info('Channel updated', { channelId: id });

    res.json({ channel: updatedChannel });
  } catch (error) {
    logger.error('Update channel error', { error: error.message });
    res.status(500).json({ error: 'Internal server error' });
  }
};

// Delete channel
export const deleteChannel = async (req, res) => {
  try {
    const { id } = req.params;

    const channel = Channel.findById(id);

    if (!channel) {
      return res.status(404).json({ error: 'Channel not found' });
    }

    // Check ownership (admins can delete all, users only their own)
    if (req.user.role !== 'admin' && channel.user_id !== req.user.id) {
      return res.status(403).json({ error: 'Access denied' });
    }

    // Stop stream if running
    if (channel.status === 'running') {
      await streamManager.stopStream(id);
    }

    // Clean up HLS files
    streamManager.cleanupChannel(id);

    // Delete from database
    Channel.delete(id);

    logger.info('Channel deleted', { channelId: id });

    res.json({ message: 'Channel deleted successfully' });
  } catch (error) {
    logger.error('Delete channel error', { error: error.message });
    res.status(500).json({ error: 'Internal server error' });
  }
};

// Start stream
export const startStream = async (req, res) => {
  try {
    const { id } = req.params;

    const channel = Channel.findById(id);

    if (!channel) {
      return res.status(404).json({ error: 'Channel not found' });
    }

    // Check ownership (admins can start all, users only their own)
    if (req.user.role !== 'admin' && channel.user_id !== req.user.id) {
      return res.status(403).json({ error: 'Access denied' });
    }

    if (channel.status === 'running') {
      return res.status(400).json({ error: 'Stream is already running' });
    }

    const result = await streamManager.startStream(id, req.user);

    logger.info('Stream started', { channelId: id, userId: req.user.id });

    res.json({
      message: result.message,
      channel: Channel.findById(id),
    });
  } catch (error) {
    logger.error('Start stream error', { error: error.message });
    res.status(500).json({ error: error.message });
  }
};

// Stop stream
export const stopStream = async (req, res) => {
  try {
    const { id } = req.params;

    const channel = Channel.findById(id);

    if (!channel) {
      return res.status(404).json({ error: 'Channel not found' });
    }

    // Check ownership (admins can stop all, users only their own)
    if (req.user.role !== 'admin' && channel.user_id !== req.user.id) {
      return res.status(403).json({ error: 'Access denied' });
    }

    const result = await streamManager.stopStream(id);

    logger.info('Stream stopped', { channelId: id, userId: req.user.id });

    res.json({
      message: result.message,
      channel: Channel.findById(id),
    });
  } catch (error) {
    logger.error('Stop stream error', { error: error.message });
    res.status(500).json({ error: error.message });
  }
};

// Get channel logs
export const getChannelLogs = (req, res) => {
  try {
    const { id } = req.params;
    const limit = parseInt(req.query.limit) || 100;

    const channel = Channel.findById(id);

    if (!channel) {
      return res.status(404).json({ error: 'Channel not found' });
    }

    // Check ownership (admins can view all logs, users only their own)
    if (req.user.role !== 'admin' && channel.user_id !== req.user.id) {
      return res.status(403).json({ error: 'Access denied' });
    }

    const logs = Channel.getLogs(id, limit);

    res.json({ logs });
  } catch (error) {
    logger.error('Get channel logs error', { error: error.message });
    res.status(500).json({ error: 'Internal server error' });
  }
};
