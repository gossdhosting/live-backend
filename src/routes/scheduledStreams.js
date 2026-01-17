import express from 'express';
import {
  getUserScheduledStreams,
  getAllScheduledStreams,
  getChannelScheduledStreams,
  getActiveSchedule,
  createScheduledStream,
  updateScheduledStream,
  cancelScheduledStream,
  deleteScheduledStream,
} from '../controllers/scheduledStreamController.js';
import { authenticateToken, requireAdmin } from '../middleware/auth.js';

const router = express.Router();

// All routes require authentication
router.use(authenticateToken);

// User routes
router.get('/user', getUserScheduledStreams);
router.get('/channel/:channelId', getChannelScheduledStreams);
router.get('/channel/:channelId/active', getActiveSchedule);
router.post('/', createScheduledStream);
router.put('/:id', updateScheduledStream);
router.post('/:id/cancel', cancelScheduledStream);
router.delete('/:id', deleteScheduledStream);

// Admin routes
router.get('/all', requireAdmin, getAllScheduledStreams);

export default router;
