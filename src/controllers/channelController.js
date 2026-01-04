import Channel from '../models/Channel.js';
import MediaFile from '../models/MediaFile.js';
import streamManager from '../ffmpeg/StreamManager.js';
import { isValidYouTubeUrl, isValidChannelName } from '../utils/validation.js';
import logger from '../utils/logger.js';

// Get all channels
export const getAllChannels = (req, res) => {
  try {
    const channels = Channel.findAll();

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
export const createChannel = (req, res) => {
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

    const channel = Channel.create({
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
      title_enabled
    } = req.body;

    const channel = Channel.findById(id);

    if (!channel) {
      return res.status(404).json({ error: 'Channel not found' });
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
    if (input_url) updateData.input_url = input_url;
    if (auto_restart !== undefined) updateData.auto_restart = auto_restart ? 1 : 0;
    if (quality_preset) updateData.quality_preset = quality_preset;
    if (stream_title !== undefined) updateData.stream_title = stream_title;
    if (input_type) updateData.input_type = input_type;
    if (media_file_id !== undefined) updateData.media_file_id = media_file_id;
    if (loop_video !== undefined) updateData.loop_video = loop_video ? 1 : 0;
    if (title_enabled !== undefined) updateData.title_enabled = title_enabled ? 1 : 0;

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

    if (channel.status === 'running') {
      return res.status(400).json({ error: 'Stream is already running' });
    }

    const result = await streamManager.startStream(id);

    logger.info('Stream started', { channelId: id });

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

    const result = await streamManager.stopStream(id);

    logger.info('Stream stopped', { channelId: id });

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

    const logs = Channel.getLogs(id, limit);

    res.json({ logs });
  } catch (error) {
    logger.error('Get channel logs error', { error: error.message });
    res.status(500).json({ error: 'Internal server error' });
  }
};
