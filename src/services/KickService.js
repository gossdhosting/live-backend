import axios from 'axios';
import crypto from 'crypto';
import platformConfig from '../config/platforms.js';
import PlatformConnection from '../models/PlatformConnection.js';
import logger from '../utils/logger.js';

class KickService {
  // Token refresh locks to prevent concurrent refreshes
  static tokenRefreshLocks = new Map();

  // PKCE code verifiers (temporary storage)
  static codeVerifiers = new Map();

  // Generate PKCE code verifier and challenge
  static generatePKCE() {
    // Generate random code verifier (43-128 characters)
    const codeVerifier = crypto.randomBytes(32).toString('base64url');

    // Generate code challenge using S256 method
    const codeChallenge = crypto
      .createHash('sha256')
      .update(codeVerifier)
      .digest('base64url');

    return { codeVerifier, codeChallenge };
  }

  // Generate OAuth2 authorization URL with PKCE
  static getAuthUrl(state = '') {
    const config = platformConfig.kick;
    const { codeVerifier, codeChallenge } = this.generatePKCE();

    // Store code verifier for later use in token exchange
    const stateObj = JSON.parse(state);
    this.codeVerifiers.set(stateObj.userId, codeVerifier);

    // Clean up old verifiers (older than 10 minutes)
    setTimeout(() => this.codeVerifiers.delete(stateObj.userId), 10 * 60 * 1000);

    const params = new URLSearchParams({
      client_id: config.clientId,
      redirect_uri: config.redirectUri,
      response_type: 'code',
      state: state,
      scope: config.scopes.join(' '),
      code_challenge: codeChallenge,
      code_challenge_method: 'S256',
    });

    return `https://id.kick.com/oauth/authorize?${params.toString()}`;
  }

  // Exchange authorization code for access token
  static async getAccessToken(code, userId) {
    const config = platformConfig.kick;

    // Retrieve the code verifier for this user
    const codeVerifier = this.codeVerifiers.get(userId);
    if (!codeVerifier) {
      logger.error('Kick: Code verifier not found for user', { userId });
      throw new Error('PKCE code verifier not found');
    }

    try {
      const params = new URLSearchParams({
        grant_type: 'authorization_code',
        code: code,
        client_id: config.clientId,
        client_secret: config.clientSecret,
        redirect_uri: config.redirectUri,
        code_verifier: codeVerifier,
      });

      const response = await axios.post('https://id.kick.com/oauth/token', params.toString(), {
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
        },
      });

      // Clean up code verifier after use
      this.codeVerifiers.delete(userId);

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
      const params = new URLSearchParams({
        grant_type: 'refresh_token',
        refresh_token: refreshToken,
        client_id: config.clientId,
        client_secret: config.clientSecret,
      });

      const response = await axios.post('https://id.kick.com/oauth/token', params.toString(), {
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
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
