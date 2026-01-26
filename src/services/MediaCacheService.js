import fs from 'fs';
import path from 'path';
import https from 'https';
import http from 'http';
import { promisify } from 'util';
import logger from '../utils/logger.js';
import S3Service from './S3Service.js';

const mkdir = promisify(fs.mkdir);
const stat = promisify(fs.stat);
const unlink = promisify(fs.unlink);
const readdir = promisify(fs.readdir);

class MediaCacheService {
  constructor() {
    // Cache directory - outside uploads to avoid git tracking
    this.cacheDir = process.env.MEDIA_CACHE_DIR || path.join(process.cwd(), 'cache', 'media');

    // Maximum cache size in bytes (default: 50GB)
    this.maxCacheSize = parseInt(process.env.MAX_CACHE_SIZE_GB || '50') * 1024 * 1024 * 1024;

    // Cache metadata (in-memory for fast access)
    this.cacheMetadata = new Map(); // key: s3_key, value: { filePath, size, lastAccessed, downloading }

    this.initialized = false;
  }

  /**
   * Initialize cache directory and load existing cache metadata
   */
  async initialize() {
    try {
      // Create cache directory if it doesn't exist
      if (!fs.existsSync(this.cacheDir)) {
        await mkdir(this.cacheDir, { recursive: true });
        logger.info('Created media cache directory', { path: this.cacheDir });
      }

      // Load existing cache files
      await this.loadCacheMetadata();

      this.initialized = true;
      logger.info('MediaCacheService initialized', {
        cacheDir: this.cacheDir,
        maxCacheSize: `${Math.round(this.maxCacheSize / 1024 / 1024 / 1024)}GB`,
        cachedFiles: this.cacheMetadata.size
      });
    } catch (error) {
      logger.error('Failed to initialize MediaCacheService', { error: error.message });
      this.initialized = false;
    }
  }

  /**
   * Load metadata for existing cached files
   */
  async loadCacheMetadata() {
    try {
      const files = await readdir(this.cacheDir);

      for (const file of files) {
        const filePath = path.join(this.cacheDir, file);
        const stats = await stat(filePath);

        if (stats.isFile()) {
          // Use filename as s3_key (we'll sanitize s3_key when saving)
          this.cacheMetadata.set(file, {
            filePath,
            size: stats.size,
            lastAccessed: stats.atime.getTime(),
            downloading: false
          });
        }
      }

      logger.info('Loaded cache metadata', { files: this.cacheMetadata.size });
    } catch (error) {
      logger.error('Failed to load cache metadata', { error: error.message });
    }
  }

  /**
   * Sanitize S3 key to use as filename (replace / with _)
   */
  sanitizeKey(s3Key) {
    return s3Key.replace(/\//g, '_');
  }

  /**
   * Get cached file path for S3 media, download if not cached
   * @param {string} s3Key - S3 object key
   * @param {number} fileSize - File size in bytes (for cache management)
   * @returns {Promise<string>} Local file path
   */
  async getCachedFile(s3Key, fileSize) {
    if (!this.initialized) {
      await this.initialize();
    }

    const cacheKey = this.sanitizeKey(s3Key);
    const cachedFile = this.cacheMetadata.get(cacheKey);

    // File is in cache
    if (cachedFile && !cachedFile.downloading) {
      // Verify file still exists
      if (fs.existsSync(cachedFile.filePath)) {
        // Update last accessed time
        cachedFile.lastAccessed = Date.now();
        logger.info('Using cached media file', { s3Key, path: cachedFile.filePath });
        return cachedFile.filePath;
      } else {
        // File was deleted externally, remove from metadata
        this.cacheMetadata.delete(cacheKey);
      }
    }

    // File is being downloaded by another process, wait for it
    if (cachedFile && cachedFile.downloading) {
      logger.info('Waiting for file download to complete', { s3Key });
      return await this.waitForDownload(cacheKey, cachedFile.filePath);
    }

    // File not in cache, download it
    return await this.downloadAndCache(s3Key, fileSize);
  }

  /**
   * Wait for another process to finish downloading the file
   */
  async waitForDownload(cacheKey, filePath, maxWaitMs = 300000) {
    const startTime = Date.now();

    while (Date.now() - startTime < maxWaitMs) {
      const cachedFile = this.cacheMetadata.get(cacheKey);

      if (!cachedFile || !cachedFile.downloading) {
        if (fs.existsSync(filePath)) {
          return filePath;
        } else {
          throw new Error('Download failed or file was deleted');
        }
      }

      // Wait 1 second before checking again
      await new Promise(resolve => setTimeout(resolve, 1000));
    }

    throw new Error('Timeout waiting for file download');
  }

  /**
   * Download file from S3 and cache it locally
   */
  async downloadAndCache(s3Key, fileSize) {
    const cacheKey = this.sanitizeKey(s3Key);
    const filePath = path.join(this.cacheDir, cacheKey);

    // Mark as downloading
    this.cacheMetadata.set(cacheKey, {
      filePath,
      size: fileSize,
      lastAccessed: Date.now(),
      downloading: true
    });

    try {
      // Check if we need to free up space
      await this.ensureCacheSpace(fileSize);

      // Get signed URL from S3
      const signedUrl = await S3Service.getSignedUrl(s3Key, 3600); // 1 hour expiry

      logger.info('Downloading media file from S3 to cache', { s3Key, size: fileSize });

      // Download file
      await this.downloadFile(signedUrl, filePath);

      // Update metadata
      this.cacheMetadata.set(cacheKey, {
        filePath,
        size: fileSize,
        lastAccessed: Date.now(),
        downloading: false
      });

      logger.info('Media file cached successfully', { s3Key, path: filePath });
      return filePath;

    } catch (error) {
      // Remove from metadata on error
      this.cacheMetadata.delete(cacheKey);

      // Clean up partial download
      if (fs.existsSync(filePath)) {
        try {
          await unlink(filePath);
        } catch (unlinkError) {
          logger.error('Failed to clean up partial download', { error: unlinkError.message });
        }
      }

      logger.error('Failed to download and cache media file', { s3Key, error: error.message });
      throw error;
    }
  }

  /**
   * Download file from URL to local path
   */
  downloadFile(url, filePath) {
    return new Promise((resolve, reject) => {
      const protocol = url.startsWith('https') ? https : http;
      const file = fs.createWriteStream(filePath);

      protocol.get(url, (response) => {
        if (response.statusCode !== 200) {
          reject(new Error(`Failed to download: HTTP ${response.statusCode}`));
          return;
        }

        response.pipe(file);

        file.on('finish', () => {
          file.close();
          resolve();
        });

        file.on('error', (err) => {
          fs.unlink(filePath, () => {});
          reject(err);
        });
      }).on('error', (err) => {
        fs.unlink(filePath, () => {});
        reject(err);
      });
    });
  }

  /**
   * Ensure there's enough space in cache, evict old files if needed
   */
  async ensureCacheSpace(requiredSize) {
    const currentSize = this.getCurrentCacheSize();

    if (currentSize + requiredSize <= this.maxCacheSize) {
      return; // Enough space available
    }

    logger.info('Cache size limit approaching, evicting old files', {
      current: `${Math.round(currentSize / 1024 / 1024)}MB`,
      required: `${Math.round(requiredSize / 1024 / 1024)}MB`,
      max: `${Math.round(this.maxCacheSize / 1024 / 1024)}MB`
    });

    // Sort files by last accessed time (oldest first)
    const sortedFiles = Array.from(this.cacheMetadata.entries())
      .filter(([_, meta]) => !meta.downloading)
      .sort((a, b) => a[1].lastAccessed - b[1].lastAccessed);

    let freedSpace = 0;
    const targetFreeSpace = requiredSize + (this.maxCacheSize * 0.1); // Free 10% extra

    for (const [cacheKey, metadata] of sortedFiles) {
      if (currentSize - freedSpace + requiredSize <= this.maxCacheSize - targetFreeSpace) {
        break; // Freed enough space
      }

      try {
        await unlink(metadata.filePath);
        this.cacheMetadata.delete(cacheKey);
        freedSpace += metadata.size;

        logger.info('Evicted cached file', {
          file: cacheKey,
          size: `${Math.round(metadata.size / 1024 / 1024)}MB`,
          freedTotal: `${Math.round(freedSpace / 1024 / 1024)}MB`
        });
      } catch (error) {
        logger.error('Failed to evict cached file', { file: cacheKey, error: error.message });
      }
    }
  }

  /**
   * Get current total cache size
   */
  getCurrentCacheSize() {
    let total = 0;
    for (const [_, metadata] of this.cacheMetadata.entries()) {
      total += metadata.size;
    }
    return total;
  }

  /**
   * Get cache statistics
   */
  getCacheStats() {
    const currentSize = this.getCurrentCacheSize();

    return {
      totalFiles: this.cacheMetadata.size,
      currentSize,
      currentSizeMB: Math.round(currentSize / 1024 / 1024),
      currentSizeGB: Math.round(currentSize / 1024 / 1024 / 1024 * 100) / 100,
      maxSize: this.maxCacheSize,
      maxSizeGB: Math.round(this.maxCacheSize / 1024 / 1024 / 1024),
      utilizationPercent: Math.round((currentSize / this.maxCacheSize) * 100),
      files: Array.from(this.cacheMetadata.entries()).map(([key, meta]) => ({
        key,
        sizeMB: Math.round(meta.size / 1024 / 1024),
        lastAccessed: new Date(meta.lastAccessed).toISOString(),
        downloading: meta.downloading
      }))
    };
  }

  /**
   * Clear entire cache
   */
  async clearCache() {
    logger.info('Clearing media cache');

    for (const [cacheKey, metadata] of this.cacheMetadata.entries()) {
      try {
        if (fs.existsSync(metadata.filePath)) {
          await unlink(metadata.filePath);
        }
      } catch (error) {
        logger.error('Failed to delete cached file', { file: cacheKey, error: error.message });
      }
    }

    this.cacheMetadata.clear();
    logger.info('Media cache cleared');
  }

  /**
   * Remove specific file from cache
   */
  async removeFromCache(s3Key) {
    const cacheKey = this.sanitizeKey(s3Key);
    const cachedFile = this.cacheMetadata.get(cacheKey);

    if (!cachedFile) {
      return; // Not in cache
    }

    try {
      if (fs.existsSync(cachedFile.filePath)) {
        await unlink(cachedFile.filePath);
      }
      this.cacheMetadata.delete(cacheKey);
      logger.info('Removed file from cache', { s3Key });
    } catch (error) {
      logger.error('Failed to remove file from cache', { s3Key, error: error.message });
    }
  }
}

// Create singleton instance
const mediaCacheService = new MediaCacheService();

export default mediaCacheService;
