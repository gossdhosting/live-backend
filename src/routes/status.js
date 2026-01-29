import express from 'express';
import pm2 from 'pm2';

const router = express.Router();

// GET /api/status - Returns PM2 process status information
router.get('/', (req, res) => {
  pm2.connect((err) => {
    if (err) {
      console.error('PM2 connect error:', err);
      return res.status(500).json({
        error: 'Failed to connect to PM2',
        timestamp: new Date().toISOString()
      });
    }

    pm2.list((err, list) => {
      pm2.disconnect();

      if (err) {
        console.error('PM2 list error:', err);
        return res.status(500).json({
          error: 'Failed to get PM2 process list',
          timestamp: new Date().toISOString()
        });
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

      res.json({
        timestamp: new Date().toISOString(),
        services
      });
    });
  });
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
