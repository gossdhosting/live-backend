import express from 'express';
import { rtmpAuth, rtmpPublishDone } from '../controllers/rtmpController.js';

const router = express.Router();

// RTMP Input Authentication (called by nginx-rtmp, no auth token required)
// These endpoints are called by nginx-rtmp module when streams are published
router.post('/auth', rtmpAuth);
router.post('/done', rtmpPublishDone);

export default router;
