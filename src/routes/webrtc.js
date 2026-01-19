import express from 'express';
import {
  startWebRTC,
  handleOffer,
  createOffer,
  setAnswer,
  addIceCandidate,
  stopWebRTC,
  getStatus
} from '../controllers/webrtcController.js';
import { authenticateToken } from '../middleware/auth.js';

const router = express.Router();

// All routes require authentication
router.use(authenticateToken);

/**
 * @route   POST /api/webrtc/start/:channelId
 * @desc    Initialize WebRTC session for a channel
 * @access  Private (channel owner)
 */
router.post('/start/:channelId', startWebRTC);

/**
 * @route   POST /api/webrtc/offer/:channelId
 * @desc    Handle WebRTC offer from client (client-initiated)
 * @access  Private (channel owner)
 */
router.post('/offer/:channelId', handleOffer);

/**
 * @route   GET /api/webrtc/offer/:channelId
 * @desc    Create WebRTC offer (server-initiated)
 * @access  Private (channel owner)
 */
router.get('/offer/:channelId', createOffer);

/**
 * @route   POST /api/webrtc/answer/:channelId
 * @desc    Set WebRTC answer from client
 * @access  Private (channel owner)
 */
router.post('/answer/:channelId', setAnswer);

/**
 * @route   POST /api/webrtc/ice-candidate/:channelId
 * @desc    Handle ICE candidate from client
 * @access  Private (channel owner)
 */
router.post('/ice-candidate/:channelId', addIceCandidate);

/**
 * @route   POST /api/webrtc/stop/:channelId
 * @desc    Stop WebRTC streaming
 * @access  Private (channel owner)
 */
router.post('/stop/:channelId', stopWebRTC);

/**
 * @route   GET /api/webrtc/status/:channelId
 * @desc    Get WebRTC stream status
 * @access  Private (channel owner)
 */
router.get('/status/:channelId', getStatus);

export default router;
