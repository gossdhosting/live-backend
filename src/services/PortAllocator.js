import logger from '../config/logger.js';

/**
 * Port Allocator Service
 * Manages dynamic allocation of RTMP ports for each stream to prevent conflicts
 *
 * Port Range: 1936-2000 (65 available ports)
 * Note: Port 1935 is reserved for nginx-rtmp main server
 */
class PortAllocator {
  constructor() {
    // Port range for dynamic allocation
    this.MIN_PORT = 1936;
    this.MAX_PORT = 2000;

    // Track allocated ports: Map<channelId, port>
    this.allocatedPorts = new Map();

    // Track which ports are in use: Set<port>
    this.usedPorts = new Set();

    logger.info(`PortAllocator initialized with range ${this.MIN_PORT}-${this.MAX_PORT}`);
  }

  /**
   * Allocate a port for a channel
   * @param {number} channelId - Channel ID
   * @returns {number} Allocated port number
   * @throws {Error} If no ports available
   */
  allocate(channelId) {
    // If channel already has a port, return it
    if (this.allocatedPorts.has(channelId)) {
      const existingPort = this.allocatedPorts.get(channelId);
      logger.info(`Channel ${channelId} already has port ${existingPort}`);
      return existingPort;
    }

    // Find first available port
    for (let port = this.MIN_PORT; port <= this.MAX_PORT; port++) {
      if (!this.usedPorts.has(port)) {
        this.allocatedPorts.set(channelId, port);
        this.usedPorts.add(port);
        logger.info(`Allocated port ${port} to channel ${channelId}`);
        return port;
      }
    }

    throw new Error(`No available ports in range ${this.MIN_PORT}-${this.MAX_PORT}`);
  }

  /**
   * Release a port for a channel
   * @param {number} channelId - Channel ID
   */
  release(channelId) {
    const port = this.allocatedPorts.get(channelId);
    if (port) {
      this.allocatedPorts.delete(channelId);
      this.usedPorts.delete(port);
      logger.info(`Released port ${port} from channel ${channelId}`);
    }
  }

  /**
   * Get allocated port for a channel
   * @param {number} channelId - Channel ID
   * @returns {number|null} Port number or null if not allocated
   */
  getPort(channelId) {
    return this.allocatedPorts.get(channelId) || null;
  }

  /**
   * Check if a port is available
   * @param {number} port - Port number
   * @returns {boolean} True if available
   */
  isAvailable(port) {
    return port >= this.MIN_PORT && port <= this.MAX_PORT && !this.usedPorts.has(port);
  }

  /**
   * Get statistics
   * @returns {object} Statistics object
   */
  getStats() {
    return {
      totalPorts: this.MAX_PORT - this.MIN_PORT + 1,
      usedPorts: this.usedPorts.size,
      availablePorts: (this.MAX_PORT - this.MIN_PORT + 1) - this.usedPorts.size,
      allocations: Array.from(this.allocatedPorts.entries()).map(([channelId, port]) => ({
        channelId,
        port
      }))
    };
  }
}

// Singleton instance
const portAllocator = new PortAllocator();

export default portAllocator;
