import express from 'express';
import {
  getRtmpTemplates,
  createRtmpTemplate,
  updateRtmpTemplate,
  deleteRtmpTemplate,
} from '../controllers/rtmpTemplateController.js';
import { authenticateToken } from '../middleware/auth.js';

const router = express.Router();

// All routes require authentication
router.use(authenticateToken);

// Get all RTMP templates
router.get('/templates', getRtmpTemplates);

// Create a new RTMP template
router.post('/templates', createRtmpTemplate);

// Update an RTMP template
router.put('/templates/:id', updateRtmpTemplate);

// Delete an RTMP template
router.delete('/templates/:id', deleteRtmpTemplate);

export default router;
