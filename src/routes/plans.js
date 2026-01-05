import express from 'express';
import {
  getAllPlans,
  getPlanById,
  getPlanStats,
  createPlan,
  updatePlan,
  deletePlan
} from '../controllers/planController.js';
import { authenticateToken } from '../middleware/auth.js';
import { requireAdmin } from '../middleware/permissions.js';

const router = express.Router();

// Public routes
router.get('/', getAllPlans);
router.get('/:id', getPlanById);

// Admin only routes
router.get('/admin/stats', authenticateToken, requireAdmin, getPlanStats);
router.post('/', authenticateToken, requireAdmin, createPlan);
router.put('/:id', authenticateToken, requireAdmin, updatePlan);
router.delete('/:id', authenticateToken, requireAdmin, deletePlan);

export default router;
