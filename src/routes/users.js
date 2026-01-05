import express from 'express';
import {
  register,
  getAllUsers,
  getUserById,
  updateUser,
  deleteUser,
  getUserStats
} from '../controllers/userController.js';
import { authenticateToken } from '../middleware/auth.js';
import { requireAdmin } from '../middleware/permissions.js';
import { loginLimiter } from '../middleware/rateLimiter.js';

const router = express.Router();

// Public routes
router.post('/register', loginLimiter, register);

// Protected routes - require authentication
router.get('/stats', authenticateToken, getUserStats);
router.get('/stats/:id', authenticateToken, requireAdmin, getUserStats);

// Admin only routes
router.get('/', authenticateToken, requireAdmin, getAllUsers);
router.get('/:id', authenticateToken, getUserById); // Self or admin
router.put('/:id', authenticateToken, updateUser); // Self or admin
router.delete('/:id', authenticateToken, requireAdmin, deleteUser);

export default router;
