import express from 'express';
import {
  login,
  socialLogin,
  getCurrentUser,
  updateProfile,
  changePassword,
  adminLoginAsUser,
  forgotPassword,
  resetPassword
} from '../controllers/authController.js';
import { authenticateToken } from '../middleware/auth.js';
import { requireAdmin } from '../middleware/permissions.js';
import { loginLimiter } from '../middleware/rateLimiter.js';

const router = express.Router();

// Public routes
router.post('/login', loginLimiter, login);
router.post('/social-login', loginLimiter, socialLogin);
router.post('/forgot-password', loginLimiter, forgotPassword);
router.post('/reset-password', loginLimiter, resetPassword);

// Protected routes
router.get('/me', authenticateToken, getCurrentUser);
router.put('/profile', authenticateToken, updateProfile);
router.post('/change-password', authenticateToken, changePassword);

// Admin only routes
router.post('/admin-login-as/:userId', authenticateToken, requireAdmin, adminLoginAsUser);

export default router;
