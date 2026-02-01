import express from 'express';
import pm2 from 'pm2';
import net from 'net';
import { promisify } from 'util';

const router = express.Router();

// Helper function to check if a port is open
async function checkPort(host, port) {
  return new Promise((resolve) => {
    const socket = new net.Socket();
    const timeout = 2000;

    socket.setTimeout(timeout);
    socket.on('connect', () => {
      socket.destroy();
      resolve(true);
    });
    socket.on('timeout', () => {
      socket.destroy();
      resolve(false);
    });
    socket.on('error', () => {
      resolve(false);
    });

    socket.connect(port, host);
  });
}

// GET /api/status - Returns public system status (hides sensitive info)
router.get('/', async (req, res) => {
  try {
    // Check PM2 services
    const pm2Status = await new Promise((resolve) => {
      pm2.connect((err) => {
        if (err) {
          console.error('PM2 connect error:', err);
          return resolve({ error: 'Failed to connect to PM2', services: [] });
        }

        pm2.list((err, list) => {
          pm2.disconnect();

          if (err) {
            console.error('PM2 list error:', err);
            return resolve({ error: 'Failed to get PM2 process list', services: [] });
          }

          // Only expose minimal, non-sensitive information
          const services = list.map(proc => ({
            name: proc.name,
            status: proc.pm2_env?.status || 'unknown',
            uptimeFormatted: proc.pm2_env?.pm_uptime ? formatUptime(Date.now() - proc.pm2_env.pm_uptime) : null
          }));

          resolve({ services });
        });
      });
    });

    // Check if backend is running (which includes RTMP and WebRTC)
    const backendOnline = pm2Status.services.some(s =>
      s.name === 'streaming-backend' && s.status === 'online'
    );

    // Actually check if nginx-rtmp is listening on port 1935
    const rtmpOnline = await checkPort('127.0.0.1', 1935);

    // Compile response with minimal public information
    res.json({
      timestamp: new Date().toISOString(),
      status: 'ok',
      services: {
        backend: backendOnline ? 'online' : 'offline',
        rtmp: rtmpOnline ? 'online' : 'offline',
        webrtc: backendOnline ? 'online' : 'offline'
      },
      features: {
        rtmp: 'RTMP streaming service available',
        webrtc: 'WebRTC browser-based broadcasting available',
        multiPlatform: 'Multi-platform streaming support'
      }
    });
  } catch (error) {
    console.error('Status check error:', error);
    res.status(500).json({
      timestamp: new Date().toISOString(),
      status: 'error',
      message: 'Service temporarily unavailable'
    });
  }
});

// Helper function to format bytes to human readable format
function formatBytes(bytes) {
  if (bytes === 0) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
}

// Helper function to format uptime to human readable format
function formatUptime(ms) {
  const seconds = Math.floor(ms / 1000);
  const minutes = Math.floor(seconds / 60);
  const hours = Math.floor(minutes / 60);
  const days = Math.floor(hours / 24);

  if (days > 0) {
    return `${days}d ${hours % 24}h ${minutes % 60}m`;
  } else if (hours > 0) {
    return `${hours}h ${minutes % 60}m ${seconds % 60}s`;
  } else if (minutes > 0) {
    return `${minutes}m ${seconds % 60}s`;
  } else {
    return `${seconds}s`;
  }
}

export default router;
