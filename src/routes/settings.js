import express from 'express';
import {
  getAllSettings,
  updateSettings,
} from '../controllers/settingsController.js';
import { authenticateToken, requireAdmin } from '../middleware/auth.js';

const router = express.Router();

// All routes require authentication
router.use(authenticateToken);
router.use(requireAdmin);

router.get('/', getAllSettings);
router.put('/', updateSettings);

export default router;
