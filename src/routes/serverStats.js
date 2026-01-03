import express from 'express';
import { getServerStats } from '../controllers/serverStatsController.js';
import { authenticate } from '../middleware/auth.js';

const router = express.Router();

/**
 * @route   GET /api/server-stats
 * @desc    Get server statistics (CPU, RAM, Disk, Network)
 * @access  Private
 */
router.get('/', authenticate, getServerStats);

export default router;
