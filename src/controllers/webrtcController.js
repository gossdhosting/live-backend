import webrtcBridgeService from '../services/WebRTCBridgeService.js';
import Channel from '../models/Channel.js';
import logger from '../utils/logger.js';

/**
 * Initialize WebRTC session for a channel
 */
export const startWebRTC = async (req, res) => {
  try {
    console.log('[WebRTC Start] ========== START WebRTC Request ==========');
    const { channelId } = req.params;
    const userId = req.user.userId;
    console.log('[WebRTC Start] Channel ID:', channelId, 'User ID:', userId);

    // Validate channel ownership
    const channel = await Channel.findById(channelId);
    if (!channel) {
      console.log('[WebRTC Start] Channel not found:', channelId);
      return res.status(404).json({ error: 'Channel not found' });
    }

    console.log('[WebRTC Start] Channel found:', {
      id: channel.id,
      name: channel.name,
      user_id: channel.user_id,
      input_type: channel.input_type,
      status: channel.status,
      stream_key: channel.stream_key
    });

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
      console.log('[WebRTC Start] Authorization failed - user does not own channel');
      logger.warn(`Unauthorized WebRTC access attempt`, {
        channelId,
        channelUserId,
        requestUserId,
        isAdmin
      });
      return res.status(403).json({ error: 'Unauthorized: You do not own this channel' });
    }

    if (channel.input_type !== 'webcam') {
      console.log('[WebRTC Start] Invalid input type:', channel.input_type);
      return res.status(400).json({ error: 'Channel input type must be webcam' });
    }

    // Check if channel is already streaming
    if (channel.status === 'running') {
      console.log('[WebRTC Start] Channel already running');
      return res.status(400).json({ error: 'Channel is already streaming' });
    }

    // CRITICAL: Force stop any existing connection first (fixes persistence bug)
    console.log('[WebRTC Start] Checking for existing connection...');
    if (webrtcBridgeService.peerConnections.has(channelId)) {
      console.log('[WebRTC Start] ⚠️ EXISTING CONNECTION FOUND - FORCING STOP');
      logger.warn(`Force stopping existing WebRTC connection for channel ${channelId}`);
      await webrtcBridgeService.stopBridge(channelId);
      console.log('[WebRTC Start] ✅ Existing connection stopped');
    } else {
      console.log('[WebRTC Start] No existing connection found');
    }

    console.log('[WebRTC Start] Creating peer connection...');
    // Create peer connection
    await webrtcBridgeService.createPeerConnection(channelId, channel.stream_key);
    console.log('[WebRTC Start] Peer connection created');

    // Update channel status
    await Channel.update(channelId, { status: 'waiting_for_input' });
    console.log('[WebRTC Start] Channel status updated to waiting_for_input');

    logger.info(`WebRTC session initialized for channel ${channelId}`);
    console.log('[WebRTC Start] SUCCESS - Session initialized');

    res.json({
      success: true,
      message: 'WebRTC session initialized',
      channelId
    });

  } catch (error) {
    console.error('[WebRTC Start] ERROR:', error.message);
    console.error('[WebRTC Start] Stack:', error.stack);
    logger.error('Failed to start WebRTC session', { error: error.message });
    res.status(500).json({ error: 'Failed to start WebRTC session' });
  }
};

/**
 * Handle WebRTC offer from client (client-initiated connection)
 */
export const handleOffer = async (req, res) => {
  try {
    console.log('[WebRTC Offer] ========== HANDLE OFFER Request ==========');
    const { channelId } = req.params;
    const { offer } = req.body;
    console.log('[WebRTC Offer] Channel ID:', channelId);
    console.log('[WebRTC Offer] Offer present:', !!offer);
    console.log('[WebRTC Offer] Offer type:', offer?.type);
    console.log('[WebRTC Offer] SDP length:', offer?.sdp?.length);

    if (!offer || !offer.type || !offer.sdp) {
      console.log('[WebRTC Offer] Invalid offer data');
      return res.status(400).json({ error: 'Invalid offer data' });
    }

    // Validate channel ownership
    const channel = await Channel.findById(channelId);
    if (!channel) {
      console.log('[WebRTC Offer] Channel not found:', channelId);
      return res.status(404).json({ error: 'Channel not found' });
    }

    console.log('[WebRTC Offer] Channel found, checking authorization...');

    // Compare user IDs (handle both number and string types)
    const channelUserId = parseInt(channel.user_id);
    const requestUserId = parseInt(req.user.userId);
    const isAdmin = req.user.isAdmin || req.user.role === 'admin';

    console.log('[WebRTC Offer] Auth check - Channel user:', channelUserId, 'Request user:', requestUserId, 'Is admin:', isAdmin);

    if (channelUserId !== requestUserId && !isAdmin) {
      console.log('[WebRTC Offer] Authorization failed');
      return res.status(403).json({ error: 'Unauthorized: You do not own this channel' });
    }

    console.log('[WebRTC Offer] Authorized, processing offer...');

    // Handle offer and get answer
    const answer = await webrtcBridgeService.handleOffer(channelId, offer);

    console.log('[WebRTC Offer] Answer created successfully');
    console.log('[WebRTC Offer] Answer type:', answer?.type);
    console.log('[WebRTC Offer] Answer SDP length:', answer?.sdp?.length);

    logger.info(`WebRTC offer handled for channel ${channelId}`);

    res.json({
      success: true,
      answer
    });

  } catch (error) {
    console.error('[WebRTC Offer] ERROR:', error.message);
    console.error('[WebRTC Offer] Stack:', error.stack);
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

    console.log('[WebRTC ICE] Received ICE candidate for channel:', channelId);

    if (!candidate) {
      console.log('[WebRTC ICE] Invalid candidate data');
      return res.status(400).json({ error: 'Invalid candidate data' });
    }

    // Validate channel ownership
    const channel = await Channel.findById(channelId);
    if (!channel) {
      console.log('[WebRTC ICE] Channel not found:', channelId);
      return res.status(404).json({ error: 'Channel not found' });
    }

    // Compare user IDs (handle both number and string types)
    const channelUserId = parseInt(channel.user_id);
    const requestUserId = parseInt(req.user.userId);
    const isAdmin = req.user.isAdmin || req.user.role === 'admin';

    if (channelUserId !== requestUserId && !isAdmin) {
      console.log('[WebRTC ICE] Authorization failed');
      return res.status(403).json({ error: 'Unauthorized: You do not own this channel' });
    }

    // Add ICE candidate
    logger.info(`Adding ICE candidate for channel ${channelId}`, {
      candidate: candidate.candidate?.substring(0, 50) + '...',
      sdpMid: candidate.sdpMid,
      sdpMLineIndex: candidate.sdpMLineIndex
    });

    await webrtcBridgeService.addIceCandidate(channelId, candidate);

    console.log('[WebRTC ICE] ICE candidate added successfully');

    logger.info(`ICE candidate added successfully for channel ${channelId}`);

    res.json({
      success: true,
      message: 'ICE candidate added'
    });

  } catch (error) {
    console.error('[WebRTC ICE] ERROR:', error.message);
    logger.error(`Failed to add ICE candidate for channel ${channelId}`, {
      error: error.message,
      stack: error.stack,
      candidate: req.body.candidate
    });
    res.status(500).json({ error: 'Failed to add ICE candidate', details: error.message });
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

    console.log('[WebRTC Status] Getting status for channel:', channelId);

    // Validate channel ownership
    const channel = await Channel.findById(channelId);
    if (!channel) {
      console.log('[WebRTC Status] Channel not found:', channelId);
      return res.status(404).json({ error: 'Channel not found' });
    }

    // Compare user IDs (handle both number and string types)
    const channelUserId = parseInt(channel.user_id);
    const requestUserId = parseInt(req.user.userId);
    const isAdmin = req.user.isAdmin || req.user.role === 'admin';

    if (channelUserId !== requestUserId && !isAdmin) {
      console.log('[WebRTC Status] Authorization failed');
      return res.status(403).json({ error: 'Unauthorized: You do not own this channel' });
    }

    // Get status
    const status = webrtcBridgeService.getStreamStatus(channelId);

    console.log('[WebRTC Status] Status retrieved:', JSON.stringify(status, null, 2));

    res.json({
      success: true,
      status
    });

  } catch (error) {
    console.error('[WebRTC Status] ERROR:', error.message);
    logger.error('Failed to get WebRTC status', { error: error.message });
    res.status(500).json({ error: 'Failed to get status' });
  }
};
