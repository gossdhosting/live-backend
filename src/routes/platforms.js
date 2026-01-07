import express from 'express';
import { authenticateToken } from '../middleware/auth.js';
import FacebookService from '../services/FacebookService.js';
import YouTubeService from '../services/YouTubeService.js';
import TwitchService from '../services/TwitchService.js';
import PlatformConnection from '../models/PlatformConnection.js';
import PlatformStream from '../models/PlatformStream.js';
import RtmpDestination from '../models/RtmpDestination.js';
import Channel from '../models/Channel.js';
import logger from '../utils/logger.js';

const router = express.Router();

// Get all platform connections for current user
router.get('/connections', authenticateToken, async (req, res) => {
  try {
    const connections = await PlatformConnection.getByUserId(req.user.id);

    // Remove sensitive tokens from response
    const safeConnections = connections.map(conn => ({
      id: conn.id,
      platform: conn.platform,
      platform_user_name: conn.platform_user_name,
      platform_user_email: conn.platform_user_email,
      platform_page_name: conn.platform_page_name,
      platform_channel_name: conn.platform_channel_name,
      created_at: conn.created_at,
      is_expired: PlatformConnection.isTokenExpired(conn),
    }));

    res.json({ connections: safeConnections });
  } catch (error) {
    logger.error('Failed to get platform connections', { error: error.message, userId: req.user.id });
    res.status(500).json({ error: 'Failed to get platform connections' });
  }
});

// Delete a platform connection
router.delete('/connections/:id', authenticateToken, async (req, res) => {
  try {
    const connection = await PlatformConnection.getById(req.params.id);

    if (!connection) {
      return res.status(404).json({ error: 'Connection not found' });
    }

    // Normalize IDs to numbers for strict comparison
    const connectionUserId = Number(connection.user_id);
    const requestUserId = Number(req.user.id);

    if (connectionUserId !== requestUserId) {
      logger.warn('Unauthorized connection delete attempt', {
        connectionUserId,
        requestUserId,
        connectionId: req.params.id
      });
      return res.status(403).json({ error: 'Unauthorized' });
    }

    await PlatformConnection.delete(req.params.id);

    logger.info('Platform connection deleted', { connectionId: req.params.id, userId: req.user.id });

    res.json({ message: 'Connection deleted successfully' });
  } catch (error) {
    logger.error('Failed to delete platform connection', { error: error.message });
    res.status(500).json({ error: 'Failed to delete connection' });
  }
});

// Get Facebook pages for connected account
router.get('/facebook/pages', authenticateToken, async (req, res) => {
  try {
    const connection = await PlatformConnection.getByPlatformAndUser('facebook', req.user.id);

    if (!connection) {
      return res.status(404).json({ error: 'Facebook account not connected' });
    }

    const accessToken = await FacebookService.refreshTokenIfNeeded(connection);
    const pages = await FacebookService.getPages(accessToken);

    res.json({ pages });
  } catch (error) {
    logger.error('Failed to get Facebook pages', { error: error.message });
    res.status(500).json({ error: error.message || 'Failed to get Facebook pages' });
  }
});

// Create Facebook live stream
router.post('/facebook/create-stream', authenticateToken, async (req, res) => {
  try {
    const { channelId, pageId, pageAccessToken, title, description } = req.body;

    if (!channelId || !pageId || !pageAccessToken || !title) {
      return res.status(400).json({ error: 'Missing required fields' });
    }

    // Validate channel exists and check ownership
    const channel = await Channel.findById(channelId);
    if (!channel) {
      return res.status(404).json({ error: 'Channel not found' });
    }

    // Check channel ownership (admins can access all, users only their own)
    if (req.user.role !== 'admin' && Number(channel.user_id) !== Number(req.user.id)) {
      return res.status(403).json({ error: 'Unauthorized access to this channel' });
    }

    const connection = await PlatformConnection.getByPlatformAndUser('facebook', req.user.id);

    if (!connection) {
      return res.status(404).json({ error: 'Facebook account not connected' });
    }

    // Check for duplicate Facebook stream
    const existingStreams = PlatformStream.getByChannelId(channelId);
    const existingFacebookStream = existingStreams.find(s => s.platform === 'facebook' && s.enabled === 1);
    if (existingFacebookStream) {
      return res.status(400).json({
        error: 'A Facebook stream already exists for this channel. Please delete the existing one first.'
      });
    }

    // Refresh token if needed
    await FacebookService.refreshTokenIfNeeded(connection);

    // Create live video
    const liveVideo = await FacebookService.createLiveVideo(pageId, pageAccessToken, title, description);

    // Save platform stream (single source of truth)
    const platformStream = await PlatformStream.create({
      channel_id: channelId,
      platform_connection_id: connection.id,
      platform: 'facebook',
      platform_stream_id: liveVideo.stream_id,
      platform_broadcast_id: liveVideo.stream_id,
      rtmp_url: liveVideo.rtmp_url,
      stream_key: '', // Facebook combines URL and key
      stream_title: title,
      stream_description: description,
      status: 'created',
      enabled: 1,
    });

    logger.info('Facebook live stream created', {
      channelId,
      streamId: liveVideo.stream_id,
      platformStreamId: platformStream.id,
      userId: req.user.id,
    });

    // Check if channel is running
    const channelStatus = await Channel.findById(channelId);
    const needsRestart = channelStatus && channelStatus.status === 'running';

    res.json({
      success: true,
      platformStream,
      liveVideo,
      needsRestart,
      message: needsRestart
        ? 'Facebook stream created successfully. Please restart your channel stream to start broadcasting to Facebook.'
        : 'Facebook stream created successfully. Start your channel to begin broadcasting.'
    });
  } catch (error) {
    logger.error('Failed to create Facebook live stream', { error: error.message });
    res.status(500).json({ error: error.message || 'Failed to create Facebook live stream' });
  }
});

// Create YouTube live broadcast
router.post('/youtube/create-broadcast', authenticateToken, async (req, res) => {
  try {
    const { channelId, title, description } = req.body;

    if (!channelId || !title) {
      return res.status(400).json({ error: 'Channel ID and title are required' });
    }

    // Validate channel exists and check ownership
    const channel = await Channel.findById(channelId);
    if (!channel) {
      return res.status(404).json({ error: 'Channel not found' });
    }

    // Check channel ownership (admins can access all, users only their own)
    if (req.user.role !== 'admin' && Number(channel.user_id) !== Number(req.user.id)) {
      return res.status(403).json({ error: 'Unauthorized access to this channel' });
    }

    const connection = await PlatformConnection.getByPlatformAndUser('youtube', req.user.id);

    if (!connection) {
      return res.status(404).json({ error: 'YouTube account not connected' });
    }

    // Check for duplicate YouTube stream
    const existingStreams = PlatformStream.getByChannelId(channelId);
    const existingYouTubeStream = existingStreams.find(s => s.platform === 'youtube' && s.enabled === 1);
    if (existingYouTubeStream) {
      return res.status(400).json({
        error: 'A YouTube stream already exists for this channel. Please delete the existing one first.'
      });
    }

    const accessToken = await YouTubeService.refreshTokenIfNeeded(connection);

    // Create live broadcast
    const broadcast = await YouTubeService.createLiveBroadcast(
      accessToken,
      connection.refresh_token,
      title,
      description,
      null, // scheduledStartTime
      connection.id // connectionId for automatic token refresh
    );

    // Save platform stream (single source of truth)
    const platformStream = await PlatformStream.create({
      channel_id: channelId,
      platform_connection_id: connection.id,
      platform: 'youtube',
      platform_stream_id: broadcast.stream_id,
      platform_broadcast_id: broadcast.broadcast_id,
      rtmp_url: broadcast.rtmp_url,
      stream_key: broadcast.stream_key,
      stream_title: title,
      stream_description: description,
      status: 'created',
      enabled: 1,
    });

    logger.info('YouTube live broadcast created', {
      channelId,
      broadcastId: broadcast.broadcast_id,
      platformStreamId: platformStream.id,
      userId: req.user.id,
    });

    // Check if channel is running
    const channelStatus = await Channel.findById(channelId);
    const needsRestart = channelStatus && channelStatus.status === 'running';

    res.json({
      success: true,
      platformStream,
      broadcast,
      needsRestart,
      message: needsRestart
        ? 'YouTube stream created successfully. Please restart your channel stream to start broadcasting to YouTube.'
        : 'YouTube stream created successfully. Start your channel to begin broadcasting.'
    });
  } catch (error) {
    logger.error('Failed to create YouTube live broadcast', { error: error.message });
    res.status(500).json({ error: error.message || 'Failed to create YouTube live broadcast' });
  }
});

// Setup Twitch stream
router.post('/twitch/setup-stream', authenticateToken, async (req, res) => {
  try {
    const { channelId, title, categoryId } = req.body;

    if (!channelId || !title) {
      return res.status(400).json({ error: 'Channel ID and title are required' });
    }

    // Validate channel exists and check ownership
    const channel = await Channel.findById(channelId);
    if (!channel) {
      return res.status(404).json({ error: 'Channel not found' });
    }

    // Check channel ownership (admins can access all, users only their own)
    if (req.user.role !== 'admin' && Number(channel.user_id) !== Number(req.user.id)) {
      return res.status(403).json({ error: 'Unauthorized access to this channel' });
    }

    const connection = await PlatformConnection.getByPlatformAndUser('twitch', req.user.id);

    if (!connection) {
      return res.status(404).json({ error: 'Twitch account not connected' });
    }

    // Check for duplicate Twitch stream
    const existingStreams = PlatformStream.getByChannelId(channelId);
    const existingTwitchStream = existingStreams.find(s => s.platform === 'twitch' && s.enabled === 1);
    if (existingTwitchStream) {
      return res.status(400).json({
        error: 'A Twitch stream already exists for this channel. Please delete the existing one first.'
      });
    }

    const accessToken = await TwitchService.refreshTokenIfNeeded(connection);

    // Setup stream
    const stream = await TwitchService.setupStream(
      accessToken,
      connection.platform_user_id,
      title,
      categoryId
    );

    // Save platform stream (single source of truth)
    const platformStream = await PlatformStream.create({
      channel_id: channelId,
      platform_connection_id: connection.id,
      platform: 'twitch',
      rtmp_url: stream.rtmp_url,
      stream_key: stream.stream_key,
      stream_title: title,
      status: 'created',
      enabled: 1,
    });

    logger.info('Twitch stream setup', {
      channelId,
      platformStreamId: platformStream.id,
      userId: req.user.id,
    });

    // Check if channel is running
    const channelStatus = await Channel.findById(channelId);
    const needsRestart = channelStatus && channelStatus.status === 'running';

    res.json({
      success: true,
      platformStream,
      stream,
      needsRestart,
      message: needsRestart
        ? 'Twitch stream created successfully. Please restart your channel stream to start broadcasting to Twitch.'
        : 'Twitch stream created successfully. Start your channel to begin broadcasting.'
    });
  } catch (error) {
    logger.error('Failed to setup Twitch stream', { error: error.message });
    res.status(500).json({ error: error.message || 'Failed to setup Twitch stream' });
  }
});

// Get platform streams for a channel
router.get('/streams/:channelId', authenticateToken, async (req, res) => {
  try {
    const streams = await PlatformStream.getAllWithConnectionByChannel(req.params.channelId);
    res.json({ streams });
  } catch (error) {
    logger.error('Failed to get platform streams', { error: error.message });
    res.status(500).json({ error: 'Failed to get platform streams' });
  }
});

// Delete platform stream
router.delete('/streams/:id', authenticateToken, async (req, res) => {
  try {
    const stream = await PlatformStream.getById(req.params.id);

    if (!stream) {
      return res.status(404).json({ error: 'Stream not found' });
    }

    // Validate ownership
    const channel = await Channel.findById(stream.channel_id);
    if (!channel) {
      return res.status(404).json({ error: 'Channel not found' });
    }

    if (req.user.role !== 'admin' && Number(channel.user_id) !== Number(req.user.id)) {
      return res.status(403).json({ error: 'Unauthorized access to this stream' });
    }

    // Delete platform stream - CASCADE will handle rtmp_destination if it exists
    await PlatformStream.delete(req.params.id);

    logger.info('Platform stream deleted', {
      streamId: req.params.id,
      channelId: stream.channel_id,
      platform: stream.platform,
      userId: req.user.id
    });

    // Check if channel is running and notify user to restart
    const needsRestart = channel.status === 'running';

    res.json({
      message: 'Stream deleted successfully',
      needsRestart,
      restartMessage: needsRestart
        ? 'Please restart your channel stream to apply changes.'
        : null
    });
  } catch (error) {
    logger.error('Failed to delete platform stream', { error: error.message });
    res.status(500).json({ error: 'Failed to delete stream' });
  }
});

export default router;
