import express from 'express';
import { authenticateToken, requireAdmin } from '../middleware/auth.js';
import MediaCacheService from '../services/MediaCacheService.js';
import logger from '../utils/logger.js';

const router = express.Router();

// All routes require admin authentication
router.use(authenticateToken);
router.use(requireAdmin);

// Get cache statistics
router.get('/stats', async (req, res) => {
  try {
    const stats = MediaCacheService.getCacheStats();
    res.json(stats);
  } catch (error) {
    logger.error('Failed to get cache stats', { error: error.message });
    res.status(500).json({ error: 'Failed to get cache statistics' });
  }
});

// Clear entire cache
router.post('/clear', async (req, res) => {
  try {
    await MediaCacheService.clearCache();
    logger.info('Cache cleared by admin', { userId: req.user.id });
    res.json({ message: 'Cache cleared successfully' });
  } catch (error) {
    logger.error('Failed to clear cache', { error: error.message });
    res.status(500).json({ error: 'Failed to clear cache' });
  }
});

// Remove specific file from cache
router.delete('/:s3Key', async (req, res) => {
  try {
    const { s3Key } = req.params;
    await MediaCacheService.removeFromCache(decodeURIComponent(s3Key));
    logger.info('File removed from cache by admin', { userId: req.user.id, s3Key });
    res.json({ message: 'File removed from cache successfully' });
  } catch (error) {
    logger.error('Failed to remove file from cache', { error: error.message });
    res.status(500).json({ error: 'Failed to remove file from cache' });
  }
});

export default router;
