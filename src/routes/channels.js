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
import { checkPlanLimit } from '../middleware/permissions.js';
import { streamControlLimiter } from '../middleware/rateLimiter.js';

const router = express.Router();

// All routes require authentication
router.use(authenticateToken);

// Channel CRUD
router.get('/', getAllChannels);
router.get('/:id', getChannel);
router.post('/', checkPlanLimit('stream'), createChannel);
router.put('/:id', updateChannel);
router.delete('/:id', deleteChannel);

// Stream control
router.post('/:id/start', streamControlLimiter, checkPlanLimit('stream'), startStream);
router.post('/:id/stop', streamControlLimiter, stopStream);

// Logs
router.get('/:id/logs', getChannelLogs);

export default router;
