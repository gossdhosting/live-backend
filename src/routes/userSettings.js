import express from 'express';
import {
  getUserSettings,
  updateUserSettings,
  resetUserSettings,
} from '../controllers/userSettingsController.js';
import { authenticateToken } from '../middleware/auth.js';

const router = express.Router();

// All routes require authentication
router.use(authenticateToken);

// User settings routes - users can view and update their own settings
router.get('/', getUserSettings);
router.put('/', updateUserSettings);
router.post('/reset', resetUserSettings);

export default router;
