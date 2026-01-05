import express from 'express';
import {
  getRtmpDestinations,
  createRtmpDestination,
  updateRtmpDestination,
  deleteRtmpDestination,
  toggleTemplateForChannel,
} from '../controllers/rtmpController.js';
import { authenticateToken, requireAdmin } from '../middleware/auth.js';

const router = express.Router();

// All routes require authentication
router.use(authenticateToken);

// RTMP destination management (users can manage their own channels)
router.get('/channels/:channelId/rtmp', getRtmpDestinations);
router.post('/channels/:channelId/rtmp', createRtmpDestination);
router.put('/rtmp/:id', updateRtmpDestination);
router.delete('/rtmp/:id', deleteRtmpDestination);

// Toggle template for channel
router.post('/channels/:channelId/rtmp/template/:templateId/toggle', toggleTemplateForChannel);

export default router;
