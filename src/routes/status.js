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

// GET /api/status - Returns comprehensive system status
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

          const services = list.map(proc => ({
            name: proc.name,
            status: proc.pm2_env?.status || 'unknown',
            uptime: proc.pm2_env?.pm_uptime ? Date.now() - proc.pm2_env.pm_uptime : null,
            uptimeFormatted: proc.pm2_env?.pm_uptime ? formatUptime(Date.now() - proc.pm2_env.pm_uptime) : null,
            restarts: proc.pm2_env?.restart_time || 0,
            memory: proc.monit?.memory || 0,
            memoryFormatted: formatBytes(proc.monit?.memory || 0),
            cpu: proc.monit?.cpu || 0,
            pid: proc.pid,
            instances: proc.pm2_env?.instances || 1,
            mode: proc.pm2_env?.exec_mode || 'unknown'
          }));

          resolve({ services });
        });
      });
    });

    // Check if backend is running (which includes RTMP and WebRTC)
    const backendOnline = pm2Status.services.some(s =>
      s.name === 'streaming-backend' && s.status === 'online'
    );

    // RTMP and WebRTC are integrated into the backend, so their status follows the backend status
    const rtmpHost = process.env.RTMP_SERVER || '127.0.0.1';
    const rtmpPort = parseInt(process.env.RTMP_PORT || '1935');
    const rtmpPortRange = `${process.env.RTMP_DYNAMIC_PORT_MIN || '1936'}-${process.env.RTMP_DYNAMIC_PORT_MAX || '2000'}`;

    // Compile response
    res.json({
      timestamp: new Date().toISOString(),
      status: 'ok',
      pm2: pm2Status,
      rtmp: {
        enabled: true,
        integrated: true,
        host: rtmpHost,
        port: rtmpPort,
        dynamicPorts: rtmpPortRange,
        status: backendOnline ? 'online' : 'offline',
        description: backendOnline
          ? `RTMP streaming service integrated in backend (port ${rtmpPort}, dynamic ports ${rtmpPortRange})`
          : 'RTMP service offline (backend not running)'
      },
      webrtc: {
        enabled: true,
        integrated: true,
        status: backendOnline ? 'online' : 'offline',
        description: backendOnline
          ? 'WebRTC streaming service integrated in backend (browser-based broadcasts)'
          : 'WebRTC service offline (backend not running)',
        features: [
          'Browser to RTMP streaming',
          'Real-time video/audio encoding',
          'Multi-platform broadcasting',
          'Integrated with FFmpeg pipelines'
        ]
      }
    });
  } catch (error) {
    console.error('Status check error:', error);
    res.status(500).json({
      timestamp: new Date().toISOString(),
      status: 'error',
      error: error.message
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
