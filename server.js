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
import billingRoutes from './src/routes/billing.js';
import webhookRoutes from './src/routes/webhooks.js';
import iapRoutes from './src/routes/iap.js';
import appRoutes from './src/routes/app.js';
import scheduledStreamRoutes from './src/routes/scheduledStreams.js';
import faqRoutes from './src/routes/faq.js';
import webrtcRoutes from './src/routes/webrtc.js';
import cacheRoutes from './src/routes/cache.js';
import statusRoutes from './src/routes/status.js';

// Middleware
import { apiLimiter } from './src/middleware/rateLimiter.js';

// Utils
import logger from './src/utils/logger.js';

// Stripe configuration
import stripeConfig from './src/config/stripe.js';

// Scheduler service
import schedulerService from './src/services/schedulerService.js';

// Initialize database (imported for side effects)
import './src/models/database.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
app.set('trust proxy', 1); // Add this line
const PORT = process.env.PORT || 3000;

// Middleware
app.use(cors());

// Webhook route needs raw body for Stripe signature verification
// Must come BEFORE express.json() middleware
app.use('/api/webhooks', webhookRoutes);

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
app.use('/api/rtmp/templates', rtmpTemplateRoutes);
app.use('/api/watermark', watermarkRoutes);
app.use('/api/server-stats', serverStatsRoutes);
app.use('/api/media', mediaRoutes);
app.use('/api/rtmp', rtmpRoutes);
app.use('/api/billing', billingRoutes);
app.use('/api/iap', iapRoutes);
app.use('/api/scheduled-streams', scheduledStreamRoutes);
app.use('/api/faqs', faqRoutes);
app.use('/api/webrtc', webrtcRoutes);
app.use('/api/cache', cacheRoutes);
app.use('/api/status', statusRoutes);

// Public API (for Flutter app)
app.use('/api/public', publicRoutes);

// App deep link routes
app.use('/api/app', appRoutes);

// Serve .well-known files for deep linking (iOS Universal Links & Android App Links)
const wellKnownPath = path.join(__dirname, '.well-known');
app.use('/.well-known', express.static(wellKnownPath, {
  setHeaders: (res, filePath) => {
    // Set proper Content-Type for deep link files
    if (filePath.endsWith('assetlinks.json') || filePath.endsWith('apple-app-site-association')) {
      res.setHeader('Content-Type', 'application/json');
    }
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Cache-Control', 'no-cache'); // Don't cache these files
  },
  fallthrough: false, // Return 404 if file not found instead of continuing to next handler
}));

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

// Serve uploaded media files
const uploadsPath = process.env.UPLOADS_PATH || path.join(process.cwd(), 'uploads');
app.use('/uploads', express.static(uploadsPath, {
  setHeaders: (res, filePath) => {
    // Set CORS headers
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

    // Set appropriate content type for videos
    if (filePath.endsWith('.mp4')) {
      res.setHeader('Content-Type', 'video/mp4');
    } else if (filePath.endsWith('.webm')) {
      res.setHeader('Content-Type', 'video/webm');
    } else if (filePath.endsWith('.mkv')) {
      res.setHeader('Content-Type', 'video/x-matroska');
    }

    // Cache control for videos
    res.setHeader('Cache-Control', 'public, max-age=86400'); // 1 day cache
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
    // Initialize Stripe configuration
    const stripeInitialized = await stripeConfig.initialize();

    const server = app.listen(PORT, () => {
      logger.info(`Server started on port ${PORT}`, {
        nodeEnv: process.env.NODE_ENV,
        hlsBasePath,
        stripeConfigured: stripeInitialized,
      });

      // Start scheduler service
      schedulerService.start();

      console.log('');
      console.log('🚀 Multi-Channel Streaming Platform');
      console.log('='.repeat(60));
      console.log(`Server running on: http://localhost:${PORT}`);
      console.log(`Environment: ${process.env.NODE_ENV || 'development'}`);
      console.log(`HLS Base Path: ${hlsBasePath}`);
      console.log(`Stripe: ${stripeInitialized ? '✓ Configured' : '✗ Not configured'}`);
      console.log('='.repeat(60));
      console.log('');
      console.log('API Endpoints:');
      console.log(`  POST   http://localhost:${PORT}/api/auth/login`);
      console.log(`  GET    http://localhost:${PORT}/api/channels`);
      console.log(`  POST   http://localhost:${PORT}/api/channels`);
      console.log(`  POST   http://localhost:${PORT}/api/channels/:id/start`);
      console.log(`  POST   http://localhost:${PORT}/api/channels/:id/stop`);
      console.log(`  GET    http://localhost:${PORT}/api/public/channels`);
      console.log(`  POST   http://localhost:${PORT}/api/billing/create-checkout-session`);
      console.log(`  POST   http://localhost:${PORT}/api/webhooks/stripe`);
      console.log('='.repeat(60));
      console.log('');
    });

    // Handle server errors gracefully (prevents ECONNRESET crashes)
    server.on('error', (error) => {
      logger.error('HTTP Server error:', { error: error.message, code: error.code });
    });

    // Handle client connection errors
    server.on('clientError', (err, socket) => {
      logger.warn('Client connection error:', { error: err.message });
      if (!socket.destroyed) {
        socket.end('HTTP/1.1 400 Bad Request\r\n\r\n');
      }
    });
  } catch (error) {
    logger.error('Failed to start server', { error: error.message });
    process.exit(1);
  }
};

// Global error handlers to prevent crashes
process.on('uncaughtException', (error) => {
  logger.error('Uncaught Exception:', { error: error.message, stack: error.stack });
  // Don't exit - log and continue
});

process.on('unhandledRejection', (reason, promise) => {
  logger.error('Unhandled Rejection:', { reason, promise });
  // Don't exit - log and continue
});

// Graceful shutdown handlers to cleanup native C++ objects (wrtc) before PM2 restart
// CRITICAL: Stop FFmpeg first, then WebRTC, then wait for C++ destructors before exiting
process.on('SIGTERM', async () => {
  logger.info('SIGTERM received - Starting graceful shutdown');
  console.log('[Graceful Shutdown] SIGTERM received, cleaning up all resources...');
  console.log('[Graceful Shutdown] Process PID:', process.pid);

  try {
    // Import services
    const webrtcBridge = (await import('./src/services/WebRTCBridgeService.js')).default;
    const streamManager = (await import('./src/ffmpeg/StreamManager.js')).default;

    // 1. Stop all FFmpeg processes first (cleans up video/audio pipelines)
    console.log('[Graceful Shutdown] Step 1: Stopping all FFmpeg streams...');
    await streamManager.stopAllStreams();
    logger.info('All FFmpeg streams stopped');

    // 2. Then stop WebRTC bridges (closes peer connections and native sinks)
    console.log('[Graceful Shutdown] Step 2: Stopping WebRTC bridges...');
    const activeChannels = Array.from(webrtcBridge.peerConnections.keys());
    console.log('[Graceful Shutdown] Active WebRTC channels:', activeChannels);

    // Stop all bridges in parallel using Promise.all
    await Promise.all(activeChannels.map(channelId => {
      console.log('[Graceful Shutdown] Stopping WebRTC bridge for channel:', channelId);
      return webrtcBridge.stopBridge(channelId);
    }));

    logger.info('Graceful shutdown cleanup completed - waiting for C++ destructors');
    console.log('[Graceful Shutdown] All resources cleaned up successfully');
    console.log('[Graceful Shutdown] Waiting 1 second for C++ destructors before exit...');

    // 3. Allow a 1-second grace period for C++ destructors and OS to release resources
    setTimeout(() => {
      console.log('[Graceful Shutdown] Grace period complete. Forcing process exit.');
      process.exit(0);
    }, 1000);

  } catch (error) {
    logger.error('Error during graceful shutdown:', { error: error.message });
    console.error('[Graceful Shutdown] Error:', error.message);
    process.exit(1);
  }
});

process.on('SIGINT', async () => {
  logger.info('SIGINT received - Starting graceful shutdown');
  console.log('[Graceful Shutdown] SIGINT received, cleaning up all resources...');
  console.log('[Graceful Shutdown] Process PID:', process.pid);

  try {
    // Import services
    const webrtcBridge = (await import('./src/services/WebRTCBridgeService.js')).default;
    const streamManager = (await import('./src/ffmpeg/StreamManager.js')).default;

    // 1. Stop all FFmpeg processes first (cleans up video/audio pipelines)
    console.log('[Graceful Shutdown] Step 1: Stopping all FFmpeg streams...');
    await streamManager.stopAllStreams();
    logger.info('All FFmpeg streams stopped');

    // 2. Then stop WebRTC bridges (closes peer connections and native sinks)
    console.log('[Graceful Shutdown] Step 2: Stopping WebRTC bridges...');
    const activeChannels = Array.from(webrtcBridge.peerConnections.keys());
    console.log('[Graceful Shutdown] Active WebRTC channels:', activeChannels);

    // Stop all bridges in parallel using Promise.all
    await Promise.all(activeChannels.map(channelId => {
      console.log('[Graceful Shutdown] Stopping WebRTC bridge for channel:', channelId);
      return webrtcBridge.stopBridge(channelId);
    }));

    logger.info('Graceful shutdown cleanup completed - waiting for C++ destructors');
    console.log('[Graceful Shutdown] All resources cleaned up successfully');
    console.log('[Graceful Shutdown] Waiting 1 second for C++ destructors before exit...');

    // 3. Allow a 1-second grace period for C++ destructors and OS to release resources
    setTimeout(() => {
      console.log('[Graceful Shutdown] Grace period complete. Forcing process exit.');
      process.exit(0);
    }, 1000);

  } catch (error) {
    logger.error('Error during graceful shutdown:', { error: error.message });
    console.error('[Graceful Shutdown] Error:', error.message);
    process.exit(1);
  }
});

startServer();
