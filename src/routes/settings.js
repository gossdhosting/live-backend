import express from 'express';
import {
  getAllSettings,
  updateSettings,
} from '../controllers/settingsController.js';
import { authenticateToken, requireAdmin } from '../middleware/auth.js';

const router = express.Router();

// All routes require authentication
router.use(authenticateToken);

// Settings routes - users can view, only admins can update
router.get('/', getAllSettings);
router.put('/', requireAdmin, updateSettings);

export default router;
