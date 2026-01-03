import express from 'express';
import {
  getRtmpDestinations,
  createRtmpDestination,
  updateRtmpDestination,
  deleteRtmpDestination,
} from '../controllers/rtmpController.js';
import { authenticateToken, requireAdmin } from '../middleware/auth.js';

const router = express.Router();

// All routes require authentication
router.use(authenticateToken);
router.use(requireAdmin);

// RTMP destination management
router.get('/channels/:channelId/rtmp', getRtmpDestinations);
router.post('/channels/:channelId/rtmp', createRtmpDestination);
router.put('/rtmp/:id', updateRtmpDestination);
router.delete('/rtmp/:id', deleteRtmpDestination);

export default router;
