import express from 'express';
import {
  getAllChannels,
  getChannel,
  createChannel,
  updateChannel,
  deleteChannel,
  startStream,
  stopStream,
  getChannelLogs,
} from '../controllers/channelController.js';
import { authenticateToken, requireAdmin } from '../middleware/auth.js';
import { streamControlLimiter } from '../middleware/rateLimiter.js';

const router = express.Router();

// All routes require authentication
router.use(authenticateToken);
router.use(requireAdmin);

// Channel CRUD
router.get('/', getAllChannels);
router.get('/:id', getChannel);
router.post('/', createChannel);
router.put('/:id', updateChannel);
router.delete('/:id', deleteChannel);

// Stream control
router.post('/:id/start', streamControlLimiter, startStream);
router.post('/:id/stop', streamControlLimiter, stopStream);

// Logs
router.get('/:id/logs', getChannelLogs);

export default router;
