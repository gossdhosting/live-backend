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
      const response = await axios.get('https://api.kick.com/public/v1/users', {
        headers: {
          'Authorization': `Bearer ${accessToken}`,
          'Accept': 'application/json',
        },
      });

      // API returns data array, get first user (authenticated user when no ID provided)
      const user = response.data.data[0];
      return {
        id: user.user_id,
        username: user.name,
        email: user.email,
        profile_pic: user.profile_picture,
      };
    } catch (error) {
      logger.error('Kick: Failed to get user info', { error: error.response?.data || error.message });
      throw new Error('Failed to get Kick user info');
    }
  }

  // Get channel information
  static async getChannelInfo(accessToken, slug) {
    try {
      // Use the new Kick API v1 endpoint
      const params = new URLSearchParams({ slug });
      const response = await axios.get(`https://api.kick.com/public/v1/channels?${params.toString()}`, {
        headers: {
          'Authorization': `Bearer ${accessToken}`,
          'Accept': 'application/json',
        },
      });

      // API returns data array
      if (!response.data.data || response.data.data.length === 0) {
        throw new Error('Channel not found');
      }

      return response.data.data[0];
    } catch (error) {
      logger.error('Kick: Failed to get channel info', { error: error.response?.data || error.message });
      throw new Error('Failed to get Kick channel info');
    }
  }

  // Setup stream (get RTMP URL and stream key)
  static async setupStream(accessToken, slug) {
    try {
      logger.info('Kick: Setting up stream', { slug });

      // Get channel info first to get broadcaster_user_id
      const channelInfo = await this.getChannelInfo(accessToken, slug);
      logger.info('Kick: Channel info received', {
        broadcaster_user_id: channelInfo.broadcaster_user_id,
        slug: channelInfo.slug
      });

      // Get the publish token (stream key) from the correct endpoint
      logger.info('Kick: Fetching publish token');
      const tokenResponse = await axios.get('https://api.kick.com/stream/publish_token', {
        headers: {
          'Authorization': `Bearer ${accessToken}`,
          'Accept': 'application/json',
        },
      });

      logger.info('Kick: Publish token response received', {
        hasToken: !!tokenResponse.data.token,
        hasUrl: !!tokenResponse.data.url
      });

      // Kick's standard RTMP URL format
      const rtmpUrl = tokenResponse.data.url || 'rtmps://fa723fc1b171.global-contribute.live-video.net:443/app';
      const streamKey = tokenResponse.data.token;

      if (!streamKey) {
        logger.error('Kick: Stream key not found in publish token response', {
          response: JSON.stringify(tokenResponse.data)
        });
        throw new Error('Stream key not available from Kick API');
      }

      return {
        rtmp_url: rtmpUrl,
        stream_key: streamKey,
        channel_id: channelInfo.broadcaster_user_id,
        channel_name: channelInfo.slug,
      };
    } catch (error) {
      logger.error('Kick: Failed to setup stream', {
        error: error.message,
        stack: error.stack,
        response: error.response?.data,
        slug
      });
      throw new Error('Failed to setup Kick stream');
    }
  }

  // Get stream status
  static async getStreamStatus(accessToken, slug) {
    try {
      const channelInfo = await this.getChannelInfo(accessToken, slug);

      return {
        is_live: channelInfo.stream?.is_live || false,
        stream: channelInfo.stream,
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
      const response = await axios.get('https://api.kick.com/public/v1/users', {
        headers: {
          'Authorization': `Bearer ${accessToken}`,
          'Accept': 'application/json',
        },
      });

      return {
        valid: true,
        user: response.data.data[0],
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
