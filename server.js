import express from 'express';
import cors from 'cors';
import path from 'path';
import { fileURLToPath } from 'url';
import dotenv from 'dotenv';

// Load environment variables
dotenv.config();

// Routes
import authRoutes from './src/routes/auth.js';
import userRoutes from './src/routes/users.js';
import planRoutes from './src/routes/plans.js';
import channelRoutes from './src/routes/channels.js';
import settingsRoutes from './src/routes/settings.js';
import userSettingsRoutes from './src/routes/userSettings.js';
import publicRoutes from './src/routes/public.js';
import rtmpRoutes from './src/routes/rtmp.js';
import rtmpTemplateRoutes from './src/routes/rtmpTemplates.js';
import watermarkRoutes from './src/routes/watermark.js';
import serverStatsRoutes from './src/routes/serverStats.js';
import mediaRoutes from './src/routes/media.js';
import platformAuthRoutes from './src/routes/platformAuth.js';
import platformRoutes from './src/routes/platforms.js';

// Middleware
import { apiLimiter } from './src/middleware/rateLimiter.js';

// Utils
import logger from './src/utils/logger.js';

// Initialize database (imported for side effects)
import './src/models/database.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
app.set('trust proxy', 1); // Add this line
const PORT = process.env.PORT || 3000;

// Middleware
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Apply rate limiting to all API routes
app.use('/api/', apiLimiter);

// Health check
app.get('/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// API Routes
app.use('/api/auth', authRoutes);
app.use('/api/users', userRoutes);
app.use('/api/plans', planRoutes);
app.use('/api/platforms/auth', platformAuthRoutes);
app.use('/api/platforms', platformRoutes);
app.use('/api/channels', channelRoutes);
app.use('/api/settings', settingsRoutes);
app.use('/api/user-settings', userSettingsRoutes);
app.use('/api/rtmp', rtmpTemplateRoutes);
app.use('/api/watermark', watermarkRoutes);
app.use('/api/server-stats', serverStatsRoutes);
app.use('/api/media', mediaRoutes);
app.use('/api', rtmpRoutes);

// Public API (for Flutter app)
app.use('/api/public', publicRoutes);

// Serve HLS files
const hlsBasePath = process.env.HLS_BASE_PATH || path.join(process.cwd(), 'var', 'hls');
app.use('/hls', express.static(hlsBasePath, {
  setHeaders: (res, filePath) => {
    // Set CORS headers for HLS streaming
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

    // Set appropriate content types
    if (filePath.endsWith('.m3u8')) {
      res.setHeader('Content-Type', 'application/vnd.apple.mpegurl');
    } else if (filePath.endsWith('.ts')) {
      res.setHeader('Content-Type', 'video/mp2t');
    }

    // Cache control
    if (filePath.endsWith('.m3u8')) {
      res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
    } else {
      res.setHeader('Cache-Control', 'public, max-age=31536000');
    }
  },
}));

// 404 handler
app.use((req, res) => {
  res.status(404).json({ error: 'Not found' });
});

// Error handler
app.use((err, req, res, next) => {
  logger.error('Unhandled error', {
    error: err.message,
    stack: err.stack,
    url: req.url,
  });

  res.status(500).json({
    error: process.env.NODE_ENV === 'production' ? 'Internal server error' : err.message,
  });
});

// Start server
const startServer = async () => {
  try {
    app.listen(PORT, () => {
      logger.info(`Server started on port ${PORT}`, {
        nodeEnv: process.env.NODE_ENV,
        hlsBasePath,
      });

      console.log('');
      console.log('🚀 Multi-Channel Streaming Platform');
      console.log('='.repeat(60));
      console.log(`Server running on: http://localhost:${PORT}`);
      console.log(`Environment: ${process.env.NODE_ENV || 'development'}`);
      console.log(`HLS Base Path: ${hlsBasePath}`);
      console.log('='.repeat(60));
      console.log('');
      console.log('API Endpoints:');
      console.log(`  POST   http://localhost:${PORT}/api/auth/login`);
      console.log(`  GET    http://localhost:${PORT}/api/channels`);
      console.log(`  POST   http://localhost:${PORT}/api/channels`);
      console.log(`  POST   http://localhost:${PORT}/api/channels/:id/start`);
      console.log(`  POST   http://localhost:${PORT}/api/channels/:id/stop`);
      console.log(`  GET    http://localhost:${PORT}/api/public/channels`);
      console.log('='.repeat(60));
      console.log('');
    });
  } catch (error) {
    logger.error('Failed to start server', { error: error.message });
    process.exit(1);
  }
};

startServer();
