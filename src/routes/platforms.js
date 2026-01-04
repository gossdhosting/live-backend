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

    // Validate channel exists
    const channel = await Channel.findById(channelId);
    if (!channel) {
      return res.status(404).json({ error: 'Channel not found' });
    }

    // TODO: Add channel ownership check when multi-user support is added
    // Currently channels table does not have user_id column
    // For multi-user: if (Number(channel.user_id) !== Number(req.user.id)) {
    //   return res.status(403).json({ error: 'Unauthorized access to this channel' });
    // }

    const connection = await PlatformConnection.getByPlatformAndUser('facebook', req.user.id);

    if (!connection) {
      return res.status(404).json({ error: 'Facebook account not connected' });
    }

    // Create live video
    const liveVideo = await FacebookService.createLiveVideo(pageId, pageAccessToken, title, description);

    // Add RTMP destination to channel first
    const rtmpDestination = await RtmpDestination.create({
      channel_id: channelId,
      platform: 'facebook',
      rtmp_url: liveVideo.rtmp_url,
      stream_key: '', // Facebook uses full RTMP URL
      enabled: 1,
    });

    // Save platform stream with rtmp_destination_id for precise tracking
    const platformStream = await PlatformStream.create({
      channel_id: channelId,
      platform_connection_id: connection.id,
      platform: 'facebook',
      platform_stream_id: liveVideo.stream_id,
      rtmp_url: liveVideo.rtmp_url,
      stream_key: '', // Facebook combines URL and key
      stream_title: title,
      stream_description: description,
      status: 'created',
      rtmp_destination_id: rtmpDestination.id,
    });

    logger.info('Facebook live stream created and RTMP destination added', {
      channelId,
      streamId: liveVideo.stream_id,
      rtmpDestinationId: rtmpDestination.id,
      userId: req.user.id,
    });

    // Check if channel is running
    const channelStatus = await Channel.findById(channelId);
    const needsRestart = channelStatus && channelStatus.status === 'running';

    res.json({
      success: true,
      platformStream,
      rtmpDestination,
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

    // Validate channel exists
    const channel = await Channel.findById(channelId);
    if (!channel) {
      return res.status(404).json({ error: 'Channel not found' });
    }

    // TODO: Add channel ownership check when multi-user support is added
    // Currently channels table does not have user_id column
    // For multi-user: if (Number(channel.user_id) !== Number(req.user.id)) {
    //   return res.status(403).json({ error: 'Unauthorized access to this channel' });
    // }

    const connection = await PlatformConnection.getByPlatformAndUser('youtube', req.user.id);

    if (!connection) {
      return res.status(404).json({ error: 'YouTube account not connected' });
    }

    const accessToken = await YouTubeService.refreshTokenIfNeeded(connection);

    // Create live broadcast
    const broadcast = await YouTubeService.createLiveBroadcast(
      accessToken,
      connection.refresh_token,
      title,
      description
    );

    // Add RTMP destination to channel first
    const rtmpDestination = await RtmpDestination.create({
      channel_id: channelId,
      platform: 'youtube',
      rtmp_url: broadcast.rtmp_url,
      stream_key: broadcast.stream_key,
      enabled: 1,
    });

    // Save platform stream with rtmp_destination_id for precise tracking
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
      rtmp_destination_id: rtmpDestination.id,
    });

    logger.info('YouTube live broadcast created and RTMP destination added', {
      channelId,
      broadcastId: broadcast.broadcast_id,
      rtmpDestinationId: rtmpDestination.id,
      userId: req.user.id,
    });

    // Check if channel is running
    const channelStatus = await Channel.findById(channelId);
    const needsRestart = channelStatus && channelStatus.status === 'running';

    res.json({
      success: true,
      platformStream,
      rtmpDestination,
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

    // Validate channel exists
    const channel = await Channel.findById(channelId);
    if (!channel) {
      return res.status(404).json({ error: 'Channel not found' });
    }

    // TODO: Add channel ownership check when multi-user support is added
    // Currently channels table does not have user_id column
    // For multi-user: if (Number(channel.user_id) !== Number(req.user.id)) {
    //   return res.status(403).json({ error: 'Unauthorized access to this channel' });
    // }

    const connection = await PlatformConnection.getByPlatformAndUser('twitch', req.user.id);

    if (!connection) {
      return res.status(404).json({ error: 'Twitch account not connected' });
    }

    const accessToken = await TwitchService.refreshTokenIfNeeded(connection);

    // Setup stream
    const stream = await TwitchService.setupStream(
      accessToken,
      connection.platform_user_id,
      title,
      categoryId
    );

    // Add RTMP destination to channel first
    const rtmpDestination = await RtmpDestination.create({
      channel_id: channelId,
      platform: 'twitch',
      rtmp_url: stream.rtmp_url,
      stream_key: stream.stream_key,
      enabled: 1,
    });

    // Save platform stream with rtmp_destination_id for precise tracking
    const platformStream = await PlatformStream.create({
      channel_id: channelId,
      platform_connection_id: connection.id,
      platform: 'twitch',
      rtmp_url: stream.rtmp_url,
      stream_key: stream.stream_key,
      stream_title: title,
      status: 'created',
      rtmp_destination_id: rtmpDestination.id,
    });

    logger.info('Twitch stream setup and RTMP destination added', {
      channelId,
      rtmpDestinationId: rtmpDestination.id,
      userId: req.user.id,
    });

    // Check if channel is running
    const channelStatus = await Channel.findById(channelId);
    const needsRestart = channelStatus && channelStatus.status === 'running';

    res.json({
      success: true,
      platformStream,
      rtmpDestination,
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

    // Delete associated RTMP destination using FK for precise deletion
    if (stream.rtmp_destination_id) {
      await RtmpDestination.delete(stream.rtmp_destination_id);
      logger.info('RTMP destination deleted', { rtmpDestId: stream.rtmp_destination_id });
    } else {
      // Fallback for old streams without rtmp_destination_id
      logger.warn('Platform stream missing rtmp_destination_id, attempting fallback deletion', {
        streamId: stream.id,
        platform: stream.platform,
      });
      const rtmpDestinations = await RtmpDestination.getAll(stream.channel_id);
      const rtmpDest = rtmpDestinations.find(dest =>
        dest.platform === stream.platform &&
        dest.rtmp_url === stream.rtmp_url
      );

      if (rtmpDest) {
        await RtmpDestination.delete(rtmpDest.id);
        logger.info('RTMP destination deleted via fallback', { rtmpDestId: rtmpDest.id });
      }
    }

    await PlatformStream.delete(req.params.id);

    logger.info('Platform stream deleted', { streamId: req.params.id, userId: req.user.id });

    res.json({ message: 'Stream deleted successfully' });
  } catch (error) {
    logger.error('Failed to delete platform stream', { error: error.message });
    res.status(500).json({ error: 'Failed to delete stream' });
  }
});

export default router;
