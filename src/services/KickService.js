import axios from 'axios';
import platformConfig from '../config/platforms.js';
import PlatformConnection from '../models/PlatformConnection.js';
import logger from '../utils/logger.js';

class KickService {
  // Token refresh locks to prevent concurrent refreshes
  static tokenRefreshLocks = new Map();

  // Generate OAuth2 authorization URL
  static getAuthUrl(state = '') {
    const config = platformConfig.kick;
    const params = new URLSearchParams({
      client_id: config.clientId,
      redirect_uri: config.redirectUri,
      response_type: 'code',
      state: state,
    });

    return `https://kick.com/oauth2/authorize?${params.toString()}`;
  }

  // Exchange authorization code for access token
  static async getAccessToken(code) {
    const config = platformConfig.kick;

    try {
      const response = await axios.post('https://kick.com/oauth2/token', {
        client_id: config.clientId,
        client_secret: config.clientSecret,
        code: code,
        grant_type: 'authorization_code',
        redirect_uri: config.redirectUri,
      }, {
        headers: {
          'Content-Type': 'application/json',
        },
      });

      return response.data;
    } catch (error) {
      logger.error('Kick: Failed to get access token', { error: error.response?.data || error.message });
      throw new Error('Failed to get Kick access token');
    }
  }

  // Get user info
  static async getUserInfo(accessToken) {
    try {
      const response = await axios.get('https://kick.com/api/v2/user', {
        headers: {
          'Authorization': `Bearer ${accessToken}`,
          'Accept': 'application/json',
        },
      });

      const user = response.data;
      return {
        id: user.id,
        username: user.username,
        email: user.email,
        profile_pic: user.profile_pic,
      };
    } catch (error) {
      logger.error('Kick: Failed to get user info', { error: error.response?.data || error.message });
      throw new Error('Failed to get Kick user info');
    }
  }

  // Get channel information
  static async getChannelInfo(accessToken, username) {
    try {
      const response = await axios.get(`https://kick.com/api/v2/channels/${username}`, {
        headers: {
          'Authorization': `Bearer ${accessToken}`,
          'Accept': 'application/json',
        },
      });

      return response.data;
    } catch (error) {
      logger.error('Kick: Failed to get channel info', { error: error.response?.data || error.message });
      throw new Error('Failed to get Kick channel info');
    }
  }

  // Get stream key
  static async getStreamKey(accessToken, channelId) {
    try {
      const response = await axios.get(`https://kick.com/api/v2/channels/${channelId}/keys`, {
        headers: {
          'Authorization': `Bearer ${accessToken}`,
          'Accept': 'application/json',
        },
      });

      return response.data.stream_key;
    } catch (error) {
      logger.error('Kick: Failed to get stream key', { error: error.response?.data || error.message });
      throw new Error('Failed to get Kick stream key');
    }
  }

  // Setup stream (get RTMP URL and stream key)
  static async setupStream(accessToken, username) {
    try {
      const channelInfo = await this.getChannelInfo(accessToken, username);
      const streamKey = await this.getStreamKey(accessToken, channelInfo.id);

      // Kick RTMP server (may vary by region)
      const rtmpUrl = 'rtmps://fa723fc1b171.global-contribute.live-video.net/app/';

      return {
        rtmp_url: rtmpUrl,
        stream_key: streamKey,
        channel_id: channelInfo.id,
        channel_name: channelInfo.slug,
      };
    } catch (error) {
      logger.error('Kick: Failed to setup stream', { error: error.message });
      throw new Error('Failed to setup Kick stream');
    }
  }

  // Get stream status
  static async getStreamStatus(accessToken, username) {
    try {
      const response = await axios.get(`https://kick.com/api/v2/channels/${username}`, {
        headers: {
          'Authorization': `Bearer ${accessToken}`,
          'Accept': 'application/json',
        },
      });

      return {
        is_live: response.data.livestream !== null,
        livestream: response.data.livestream,
      };
    } catch (error) {
      logger.error('Kick: Failed to get stream status', { error: error.response?.data || error.message });
      throw new Error('Failed to get Kick stream status');
    }
  }

  // Refresh access token
  static async refreshAccessToken(refreshToken) {
    const config = platformConfig.kick;

    try {
      const response = await axios.post('https://kick.com/oauth2/token', {
        client_id: config.clientId,
        client_secret: config.clientSecret,
        refresh_token: refreshToken,
        grant_type: 'refresh_token',
      }, {
        headers: {
          'Content-Type': 'application/json',
        },
      });

      return response.data;
    } catch (error) {
      logger.error('Kick: Failed to refresh access token', { error: error.response?.data || error.message });
      throw new Error('Failed to refresh Kick access token');
    }
  }

  // Refresh token if needed (with lock mechanism)
  static async refreshTokenIfNeeded(connection) {
    // Check if token is expired (with 5-minute buffer)
    if (!PlatformConnection.isTokenExpired(connection)) {
      return connection;
    }

    // Check if there's already a refresh in progress
    if (this.tokenRefreshLocks.has(connection.id)) {
      logger.info(`Kick: Token refresh already in progress for connection ${connection.id}, waiting...`);
      // Wait for the refresh to complete
      await this.tokenRefreshLocks.get(connection.id);
      // Re-fetch the connection to get the updated token
      return await PlatformConnection.getById(connection.id);
    }

    // Create a lock for this refresh
    let resolveLock;
    const lockPromise = new Promise(resolve => {
      resolveLock = resolve;
    });
    this.tokenRefreshLocks.set(connection.id, lockPromise);

    try {
      logger.info(`Kick: Refreshing access token for connection ${connection.id}`);

      if (!connection.refresh_token) {
        throw new Error('No refresh token available for Kick connection');
      }

      const tokenData = await this.refreshAccessToken(connection.refresh_token);

      const expiresAt = new Date(Date.now() + (tokenData.expires_in * 1000));

      await PlatformConnection.update(connection.id, {
        access_token: tokenData.access_token,
        refresh_token: tokenData.refresh_token || connection.refresh_token,
        token_expires_at: expiresAt,
      });

      logger.info(`Kick: Successfully refreshed token for connection ${connection.id}`);

      const updatedConnection = await PlatformConnection.getById(connection.id);
      return updatedConnection;
    } catch (error) {
      logger.error(`Kick: Failed to refresh token for connection ${connection.id}`, { error: error.message });
      throw error;
    } finally {
      // Release the lock
      resolveLock();
      this.tokenRefreshLocks.delete(connection.id);
    }
  }

  // Validate access token
  static async validateToken(accessToken) {
    try {
      const response = await axios.get('https://kick.com/api/v2/user', {
        headers: {
          'Authorization': `Bearer ${accessToken}`,
          'Accept': 'application/json',
        },
      });

      return {
        valid: true,
        user: response.data,
      };
    } catch (error) {
      logger.error('Kick: Token validation failed', { error: error.response?.data || error.message });
      return {
        valid: false,
        error: error.message,
      };
    }
  }
}

export default KickService;
