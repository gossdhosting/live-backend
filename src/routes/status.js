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

    // Check RTMP service (port 1935)
    const rtmpHost = process.env.RTMP_SERVER || '127.0.0.1';
    const rtmpPort = parseInt(process.env.RTMP_PORT || '1935');
    const rtmpStatus = await checkPort(rtmpHost, rtmpPort);

    // Check WebRTC ports (TURN server typically uses 3478, 5349)
    const webrtcTurnPort = 3478;
    const webrtcTurnTlsPort = 5349;
    const webrtcTurnStatus = await checkPort('127.0.0.1', webrtcTurnPort);
    const webrtcTurnTlsStatus = await checkPort('127.0.0.1', webrtcTurnTlsPort);

    // Compile response
    res.json({
      timestamp: new Date().toISOString(),
      status: 'ok',
      pm2: pm2Status,
      rtmp: {
        enabled: true,
        host: rtmpHost,
        port: rtmpPort,
        status: rtmpStatus ? 'online' : 'offline',
        description: rtmpStatus
          ? `RTMP server is running on ${rtmpHost}:${rtmpPort}`
          : `RTMP server is not responding on ${rtmpHost}:${rtmpPort}`
      },
      webrtc: {
        enabled: true,
        turn: {
          port: webrtcTurnPort,
          status: webrtcTurnStatus ? 'online' : 'offline',
          description: webrtcTurnStatus
            ? `TURN server is running on port ${webrtcTurnPort}`
            : `TURN server is not responding on port ${webrtcTurnPort}`
        },
        turnTls: {
          port: webrtcTurnTlsPort,
          status: webrtcTurnTlsStatus ? 'online' : 'offline',
          description: webrtcTurnTlsStatus
            ? `TURN TLS server is running on port ${webrtcTurnTlsPort}`
            : `TURN TLS server is not responding on port ${webrtcTurnTlsPort}`
        },
        description: 'WebRTC streaming service for browser-based broadcasts'
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
