import si from 'systeminformation';
import os from 'os';

/**
 * Get comprehensive server statistics
 */
export const getServerStats = async (req, res) => {
  try {
    // Get CPU info
    const cpuLoad = await si.currentLoad();
    const cpuTemp = await si.cpuTemperature();

    // Get memory info
    const mem = await si.mem();

    // Get disk info
    const fsSize = await si.fsSize();

    // Get network stats
    const networkStats = await si.networkStats();

    // Get system uptime
    const uptime = os.uptime();

    // Get OS info
    const osInfo = await si.osInfo();

    // Calculate percentages
    const memoryUsedPercent = ((mem.used / mem.total) * 100).toFixed(2);
    const diskUsedPercent = fsSize.length > 0
      ? ((fsSize[0].used / fsSize[0].size) * 100).toFixed(2)
      : 0;

    const stats = {
      cpu: {
        usage: cpuLoad.currentLoad.toFixed(2),
        cores: os.cpus().length,
        model: os.cpus()[0].model,
        temperature: cpuTemp.main || null,
      },
      memory: {
        total: mem.total,
        used: mem.used,
        free: mem.free,
        usedPercent: memoryUsedPercent,
        totalGB: (mem.total / 1024 / 1024 / 1024).toFixed(2),
        usedGB: (mem.used / 1024 / 1024 / 1024).toFixed(2),
        freeGB: (mem.free / 1024 / 1024 / 1024).toFixed(2),
      },
      disk: fsSize.length > 0 ? {
        total: fsSize[0].size,
        used: fsSize[0].used,
        available: fsSize[0].available,
        usedPercent: diskUsedPercent,
        totalGB: (fsSize[0].size / 1024 / 1024 / 1024).toFixed(2),
        usedGB: (fsSize[0].used / 1024 / 1024 / 1024).toFixed(2),
        availableGB: (fsSize[0].available / 1024 / 1024 / 1024).toFixed(2),
        mount: fsSize[0].mount,
      } : null,
      network: networkStats.length > 0 ? {
        interface: networkStats[0].iface,
        rx_sec: networkStats[0].rx_sec,
        tx_sec: networkStats[0].tx_sec,
        rx_bytes: networkStats[0].rx_bytes,
        tx_bytes: networkStats[0].tx_bytes,
      } : null,
      system: {
        platform: os.platform(),
        hostname: os.hostname(),
        uptime: uptime,
        uptimeFormatted: formatUptime(uptime),
        osDistro: osInfo.distro,
        osRelease: osInfo.release,
        arch: osInfo.arch,
      },
      timestamp: new Date().toISOString(),
    };

    res.json(stats);
  } catch (error) {
    console.error('Error fetching server stats:', error);
    res.status(500).json({ error: 'Failed to fetch server statistics' });
  }
};

/**
 * Format uptime in human-readable format
 */
function formatUptime(seconds) {
  const days = Math.floor(seconds / 86400);
  const hours = Math.floor((seconds % 86400) / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);

  const parts = [];
  if (days > 0) parts.push(`${days}d`);
  if (hours > 0) parts.push(`${hours}h`);
  if (minutes > 0) parts.push(`${minutes}m`);

  return parts.join(' ') || '0m';
}
