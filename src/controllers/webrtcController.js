import webrtcBridgeService from '../services/WebRTCBridgeService.js';
import Channel from '../models/Channel.js';
import logger from '../utils/logger.js';

/**
 * Initialize WebRTC session for a channel
 */
export const startWebRTC = async (req, res) => {
  try {
    const { channelId } = req.params;
    const userId = req.user.userId;

    // Validate channel ownership
    const channel = await Channel.findById(channelId);
    if (!channel) {
      return res.status(404).json({ error: 'Channel not found' });
    }

    // Compare user IDs (handle both number and string types)
    const channelUserId = parseInt(channel.user_id);
    const requestUserId = parseInt(userId);
    const isAdmin = req.user.isAdmin || req.user.role === 'admin';

    logger.info(`WebRTC authorization check for channel ${channelId}`, {
      channelUserId,
      requestUserId,
      isAdmin,
      match: channelUserId === requestUserId
    });

    if (channelUserId !== requestUserId && !isAdmin) {
      logger.warn(`Unauthorized WebRTC access attempt`, {
        channelId,
        channelUserId,
        requestUserId,
        isAdmin
      });
      return res.status(403).json({ error: 'Unauthorized: You do not own this channel' });
    }

    if (channel.input_type !== 'webcam') {
      return res.status(400).json({ error: 'Channel input type must be webcam' });
    }

    // Check if channel is already streaming
    if (channel.status === 'running') {
      return res.status(400).json({ error: 'Channel is already streaming' });
    }

    // Create peer connection
    await webrtcBridgeService.createPeerConnection(channelId, channel.stream_key);

    // Update channel status
    await Channel.update(channelId, { status: 'waiting_for_input' });

    logger.info(`WebRTC session initialized for channel ${channelId}`);

    res.json({
      success: true,
      message: 'WebRTC session initialized',
      channelId
    });

  } catch (error) {
    logger.error('Failed to start WebRTC session', { error: error.message });
    res.status(500).json({ error: 'Failed to start WebRTC session' });
  }
};

/**
 * Handle WebRTC offer from client (client-initiated connection)
 */
export const handleOffer = async (req, res) => {
  try {
    const { channelId } = req.params;
    const { offer } = req.body;

    if (!offer || !offer.type || !offer.sdp) {
      return res.status(400).json({ error: 'Invalid offer data' });
    }

    // Validate channel ownership
    const channel = await Channel.findById(channelId);
    if (!channel) {
      return res.status(404).json({ error: 'Channel not found' });
    }

    // Compare user IDs (handle both number and string types)
    const channelUserId = parseInt(channel.user_id);
    const requestUserId = parseInt(req.user.userId);
    const isAdmin = req.user.isAdmin || req.user.role === 'admin';

    if (channelUserId !== requestUserId && !isAdmin) {
      return res.status(403).json({ error: 'Unauthorized: You do not own this channel' });
    }

    // Handle offer and get answer
    const answer = await webrtcBridgeService.handleOffer(channelId, offer);

    logger.info(`WebRTC offer handled for channel ${channelId}`);

    res.json({
      success: true,
      answer
    });

  } catch (error) {
    logger.error('Failed to handle WebRTC offer', { error: error.message });
    res.status(500).json({ error: 'Failed to handle offer' });
  }
};

/**
 * Create WebRTC offer (server-initiated connection)
 */
export const createOffer = async (req, res) => {
  try {
    const { channelId } = req.params;

    // Validate channel ownership
    const channel = await Channel.findById(channelId);
    if (!channel) {
      return res.status(404).json({ error: 'Channel not found' });
    }

    // Compare user IDs (handle both number and string types)
    const channelUserId = parseInt(channel.user_id);
    const requestUserId = parseInt(req.user.userId);
    const isAdmin = req.user.isAdmin || req.user.role === 'admin';

    if (channelUserId !== requestUserId && !isAdmin) {
      return res.status(403).json({ error: 'Unauthorized: You do not own this channel' });
    }

    // Create offer
    const offer = await webrtcBridgeService.createOffer(channelId);

    logger.info(`WebRTC offer created for channel ${channelId}`);

    res.json({
      success: true,
      offer
    });

  } catch (error) {
    logger.error('Failed to create WebRTC offer', { error: error.message });
    res.status(500).json({ error: 'Failed to create offer' });
  }
};

/**
 * Set WebRTC answer from client
 */
export const setAnswer = async (req, res) => {
  try {
    const { channelId } = req.params;
    const { answer } = req.body;

    if (!answer || !answer.type || !answer.sdp) {
      return res.status(400).json({ error: 'Invalid answer data' });
    }

    // Validate channel ownership
    const channel = await Channel.findById(channelId);
    if (!channel) {
      return res.status(404).json({ error: 'Channel not found' });
    }

    // Compare user IDs (handle both number and string types)
    const channelUserId = parseInt(channel.user_id);
    const requestUserId = parseInt(req.user.userId);
    const isAdmin = req.user.isAdmin || req.user.role === 'admin';

    if (channelUserId !== requestUserId && !isAdmin) {
      return res.status(403).json({ error: 'Unauthorized: You do not own this channel' });
    }

    // Set answer
    await webrtcBridgeService.setAnswer(channelId, answer);

    logger.info(`WebRTC answer set for channel ${channelId}`);

    res.json({
      success: true,
      message: 'Answer set successfully'
    });

  } catch (error) {
    logger.error('Failed to set WebRTC answer', { error: error.message });
    res.status(500).json({ error: 'Failed to set answer' });
  }
};

/**
 * Handle ICE candidate from client
 */
export const addIceCandidate = async (req, res) => {
  try {
    const { channelId } = req.params;
    const { candidate } = req.body;

    if (!candidate) {
      return res.status(400).json({ error: 'Invalid candidate data' });
    }

    // Validate channel ownership
    const channel = await Channel.findById(channelId);
    if (!channel) {
      return res.status(404).json({ error: 'Channel not found' });
    }

    // Compare user IDs (handle both number and string types)
    const channelUserId = parseInt(channel.user_id);
    const requestUserId = parseInt(req.user.userId);
    const isAdmin = req.user.isAdmin || req.user.role === 'admin';

    if (channelUserId !== requestUserId && !isAdmin) {
      return res.status(403).json({ error: 'Unauthorized: You do not own this channel' });
    }

    // Add ICE candidate
    await webrtcBridgeService.addIceCandidate(channelId, candidate);

    res.json({
      success: true,
      message: 'ICE candidate added'
    });

  } catch (error) {
    logger.error('Failed to add ICE candidate', { error: error.message });
    res.status(500).json({ error: 'Failed to add ICE candidate' });
  }
};

/**
 * Stop WebRTC streaming
 */
export const stopWebRTC = async (req, res) => {
  try {
    const { channelId } = req.params;

    // Validate channel ownership
    const channel = await Channel.findById(channelId);
    if (!channel) {
      return res.status(404).json({ error: 'Channel not found' });
    }

    // Compare user IDs (handle both number and string types)
    const channelUserId = parseInt(channel.user_id);
    const requestUserId = parseInt(req.user.userId);
    const isAdmin = req.user.isAdmin || req.user.role === 'admin';

    if (channelUserId !== requestUserId && !isAdmin) {
      return res.status(403).json({ error: 'Unauthorized: You do not own this channel' });
    }

    // Stop WebRTC bridge
    await webrtcBridgeService.stopBridge(channelId);

    // Update channel status
    await Channel.update(channelId, { status: 'stopped' });

    logger.info(`WebRTC streaming stopped for channel ${channelId}`);

    res.json({
      success: true,
      message: 'WebRTC streaming stopped'
    });

  } catch (error) {
    logger.error('Failed to stop WebRTC streaming', { error: error.message });
    res.status(500).json({ error: 'Failed to stop WebRTC streaming' });
  }
};

/**
 * Get WebRTC stream status
 */
export const getStatus = async (req, res) => {
  try {
    const { channelId } = req.params;

    // Validate channel ownership
    const channel = await Channel.findById(channelId);
    if (!channel) {
      return res.status(404).json({ error: 'Channel not found' });
    }

    // Compare user IDs (handle both number and string types)
    const channelUserId = parseInt(channel.user_id);
    const requestUserId = parseInt(req.user.userId);
    const isAdmin = req.user.isAdmin || req.user.role === 'admin';

    if (channelUserId !== requestUserId && !isAdmin) {
      return res.status(403).json({ error: 'Unauthorized: You do not own this channel' });
    }

    // Get status
    const status = webrtcBridgeService.getStreamStatus(channelId);

    res.json({
      success: true,
      status
    });

  } catch (error) {
    logger.error('Failed to get WebRTC status', { error: error.message });
    res.status(500).json({ error: 'Failed to get status' });
  }
};
