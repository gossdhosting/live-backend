import express from 'express';
import {
  register,
  getAllUsers,
  getUserById,
  updateUser,
  deleteUser,
  deleteOwnAccount,
  getUserStats,
  getUserDetails
} from '../controllers/userController.js';
import { authenticateToken } from '../middleware/auth.js';
import { requireAdmin } from '../middleware/permissions.js';
import { loginLimiter } from '../middleware/rateLimiter.js';

const router = express.Router();

// Public routes
router.post('/register', loginLimiter, register);

// Protected routes - require authentication
router.get('/me/stats', authenticateToken, getUserStats);
router.get('/stats', authenticateToken, getUserStats);
router.get('/stats/:id', authenticateToken, requireAdmin, getUserStats);

// Self-deletion endpoint (user can delete their own account)
router.delete('/me', authenticateToken, deleteOwnAccount);

// Admin only routes
router.get('/', authenticateToken, requireAdmin, getAllUsers);
router.get('/:id/details', authenticateToken, requireAdmin, getUserDetails);
router.get('/:id', authenticateToken, getUserById); // Self or admin
router.put('/:id', authenticateToken, updateUser); // Self or admin
router.delete('/:id', authenticateToken, requireAdmin, deleteUser);

export default router;
