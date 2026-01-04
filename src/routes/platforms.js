import express from 'express';
import { authenticateToken } from '../middleware/auth.js';
import FacebookService from '../services/FacebookService.js';
import YouTubeService from '../services/YouTubeService.js';
import TwitchService from '../services/TwitchService.js';
import PlatformConnection from '../models/PlatformConnection.js';
import PlatformStream from '../models/PlatformStream.js';
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

    // Use loose equality to handle string/number comparison
    if (connection.user_id != req.user.id) {
      logger.warn('Unauthorized connection delete attempt', {
        connectionUserId: connection.user_id,
        requestUserId: req.user.id,
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

    if (!pageId || !pageAccessToken || !title) {
      return res.status(400).json({ error: 'Missing required fields' });
    }

    const connection = await PlatformConnection.getByPlatformAndUser('facebook', req.user.id);

    if (!connection) {
      return res.status(404).json({ error: 'Facebook account not connected' });
    }

    // Create live video
    const liveVideo = await FacebookService.createLiveVideo(pageId, pageAccessToken, title, description);

    // Save platform stream
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
    });

    logger.info('Facebook live stream created', {
      channelId,
      streamId: liveVideo.stream_id,
      userId: req.user.id,
    });

    res.json({
      success: true,
      platformStream,
      liveVideo,
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

    if (!title) {
      return res.status(400).json({ error: 'Title is required' });
    }

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

    // Save platform stream
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
    });

    logger.info('YouTube live broadcast created', {
      channelId,
      broadcastId: broadcast.broadcast_id,
      userId: req.user.id,
    });

    res.json({
      success: true,
      platformStream,
      broadcast,
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

    if (!title) {
      return res.status(400).json({ error: 'Title is required' });
    }

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

    // Save platform stream
    const platformStream = await PlatformStream.create({
      channel_id: channelId,
      platform_connection_id: connection.id,
      platform: 'twitch',
      rtmp_url: stream.rtmp_url,
      stream_key: stream.stream_key,
      stream_title: title,
      status: 'created',
    });

    logger.info('Twitch stream setup', {
      channelId,
      userId: req.user.id,
    });

    res.json({
      success: true,
      platformStream,
      stream,
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

    await PlatformStream.delete(req.params.id);

    logger.info('Platform stream deleted', { streamId: req.params.id, userId: req.user.id });

    res.json({ message: 'Stream deleted successfully' });
  } catch (error) {
    logger.error('Failed to delete platform stream', { error: error.message });
    res.status(500).json({ error: 'Failed to delete stream' });
  }
});

export default router;
