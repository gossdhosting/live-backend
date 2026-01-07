import { google } from 'googleapis';
import platformConfig from '../config/platforms.js';
import PlatformConnection from '../models/PlatformConnection.js';
import logger from '../utils/logger.js';

class YouTubeService {
  // Token refresh locks to prevent concurrent refreshes
  static tokenRefreshLocks = new Map();
  // Create OAuth2 client
  static getOAuth2Client() {
    const config = platformConfig.youtube;
    return new google.auth.OAuth2(
      config.clientId,
      config.clientSecret,
      config.redirectUri
    );
  }

  // Generate OAuth2 authorization URL
  static getAuthUrl(state = '') {
    const oauth2Client = this.getOAuth2Client();
    const config = platformConfig.youtube;

    return oauth2Client.generateAuthUrl({
      access_type: 'offline',
      scope: config.scopes,
      state: state,
      prompt: 'consent', // Force consent to get refresh token
    });
  }

  // Exchange authorization code for tokens
  static async getTokens(code) {
    const oauth2Client = this.getOAuth2Client();

    try {
      const { tokens } = await oauth2Client.getToken(code);
      return tokens;
    } catch (error) {
      logger.error('YouTube: Failed to get tokens', { error: error.message });
      throw new Error('Failed to get YouTube tokens');
    }
  }

  // Set credentials on OAuth2 client with automatic refresh
  static async setCredentials(oauth2Client, accessToken, refreshToken, connectionId = null) {
    oauth2Client.setCredentials({
      access_token: accessToken,
      refresh_token: refreshToken,
    });

    // Set up automatic token refresh handler
    if (connectionId) {
      oauth2Client.on('tokens', async (tokens) => {
        if (tokens.refresh_token) {
          // We have a new refresh token, save it
          logger.info('YouTube: Received new refresh token');
        }

        if (tokens.access_token) {
          // Update the access token in database
          const expiresAt = new Date(Date.now() + (tokens.expiry_date || 3600 * 1000));
          try {
            await PlatformConnection.update(connectionId, {
              access_token: tokens.access_token,
              refresh_token: tokens.refresh_token || refreshToken,
              token_expires_at: expiresAt.toISOString(),
            });
            logger.info('YouTube: Access token auto-refreshed and saved');
          } catch (error) {
            logger.error('YouTube: Failed to save auto-refreshed token', { error: error.message });
          }
        }
      });
    }
  }

  // Get user's channel info
  static async getChannelInfo(accessToken, refreshToken, connectionId = null) {
    const oauth2Client = this.getOAuth2Client();
    await this.setCredentials(oauth2Client, accessToken, refreshToken, connectionId);

    const youtube = google.youtube({ version: 'v3', auth: oauth2Client });

    try {
      const response = await youtube.channels.list({
        part: ['snippet', 'contentDetails', 'statistics'],
        mine: true,
      });

      if (!response.data.items || response.data.items.length === 0) {
        throw new Error('No YouTube channel found for this account');
      }

      const channel = response.data.items[0];
      return {
        id: channel.id,
        title: channel.snippet.title,
        description: channel.snippet.description,
        customUrl: channel.snippet.customUrl,
      };
    } catch (error) {
      console.error('YouTube: Failed to get channel info - DETAILED ERROR:', {
        message: error.message,
        response: error.response?.data,
        code: error.code,
        status: error.response?.status
      });
      logger.error('YouTube: Failed to get channel info', { error: error.message, details: error.response?.data });
      throw new Error(`Failed to get YouTube channel info: ${error.message}`);
    }
  }

  // Get user info
  static async getUserInfo(accessToken, refreshToken, connectionId = null) {
    const oauth2Client = this.getOAuth2Client();
    await this.setCredentials(oauth2Client, accessToken, refreshToken, connectionId);

    const oauth2 = google.oauth2({ version: 'v2', auth: oauth2Client });

    try {
      const response = await oauth2.userinfo.get();
      return response.data;
    } catch (error) {
      logger.error('YouTube: Failed to get user info', { error: error.message });
      throw new Error('Failed to get user info');
    }
  }

  // Create live broadcast
  static async createLiveBroadcast(accessToken, refreshToken, title, description, scheduledStartTime = null, connectionId = null) {
    const oauth2Client = this.getOAuth2Client();
    await this.setCredentials(oauth2Client, accessToken, refreshToken, connectionId);

    const youtube = google.youtube({ version: 'v3', auth: oauth2Client });

    try {
      // Create broadcast
      const broadcastResponse = await youtube.liveBroadcasts.insert({
        part: ['snippet', 'contentDetails', 'status'],
        requestBody: {
          snippet: {
            title: title,
            description: description || '',
            scheduledStartTime: scheduledStartTime || new Date().toISOString(),
          },
          contentDetails: {
            enableAutoStart: true,
            enableAutoStop: false,
            enableDvr: true,
            enableContentEncryption: false,
            enableEmbed: true,
            recordFromStart: true,
          },
          status: {
            privacyStatus: 'public',
            selfDeclaredMadeForKids: false,
          },
        },
      });

      const broadcast = broadcastResponse.data;

      // Create live stream
      const streamResponse = await youtube.liveStreams.insert({
        part: ['snippet', 'cdn', 'contentDetails', 'status'],
        requestBody: {
          snippet: {
            title: `Stream for: ${title}`,
          },
          cdn: {
            frameRate: 'variable',
            ingestionType: 'rtmp',
            resolution: 'variable',
          },
          contentDetails: {
            isReusable: false,
          },
        },
      });

      const stream = streamResponse.data;

      // Bind broadcast to stream
      await youtube.liveBroadcasts.bind({
        id: broadcast.id,
        part: ['id', 'contentDetails'],
        streamId: stream.id,
      });

      return {
        broadcast_id: broadcast.id,
        stream_id: stream.id,
        rtmp_url: stream.cdn.ingestionInfo.ingestionAddress,
        stream_key: stream.cdn.ingestionInfo.streamName,
        dashboard_url: `https://studio.youtube.com/video/${broadcast.id}/livestreaming`,
        watch_url: `https://www.youtube.com/watch?v=${broadcast.id}`,
      };
    } catch (error) {
      logger.error('YouTube: Failed to create live broadcast', {
        error: error.message,
        details: error.response?.data,
      });
      throw new Error(error.message || 'Failed to create YouTube live broadcast');
    }
  }

  // End live broadcast
  static async endLiveBroadcast(accessToken, refreshToken, broadcastId, connectionId = null) {
    const oauth2Client = this.getOAuth2Client();
    await this.setCredentials(oauth2Client, accessToken, refreshToken, connectionId);

    const youtube = google.youtube({ version: 'v3', auth: oauth2Client });

    try {
      await youtube.liveBroadcasts.transition({
        broadcastStatus: 'complete',
        id: broadcastId,
        part: ['id', 'status'],
      });

      return { success: true };
    } catch (error) {
      logger.error('YouTube: Failed to end live broadcast', { error: error.message });
      throw new Error('Failed to end YouTube live broadcast');
    }
  }

  // Get broadcast status
  static async getBroadcastStatus(accessToken, refreshToken, broadcastId, connectionId = null) {
    const oauth2Client = this.getOAuth2Client();
    await this.setCredentials(oauth2Client, accessToken, refreshToken, connectionId);

    const youtube = google.youtube({ version: 'v3', auth: oauth2Client });

    try {
      const response = await youtube.liveBroadcasts.list({
        part: ['snippet', 'status', 'contentDetails'],
        id: [broadcastId],
      });

      if (!response.data.items || response.data.items.length === 0) {
        throw new Error('Broadcast not found');
      }

      return response.data.items[0];
    } catch (error) {
      logger.error('YouTube: Failed to get broadcast status', { error: error.message });
      throw new Error('Failed to get broadcast status');
    }
  }

  // Refresh access token
  static async refreshAccessToken(refreshToken) {
    const oauth2Client = this.getOAuth2Client();
    oauth2Client.setCredentials({ refresh_token: refreshToken });

    try {
      const { credentials } = await oauth2Client.refreshAccessToken();
      return credentials;
    } catch (error) {
      logger.error('YouTube: Failed to refresh token', { error: error.message });
      throw new Error('Failed to refresh YouTube token');
    }
  }

  // Refresh token if needed
  static async refreshTokenIfNeeded(connection) {
    if (!PlatformConnection.isTokenExpired(connection)) {
      return connection.access_token;
    }

    if (!connection.refresh_token) {
      throw new Error('No refresh token available. Please reconnect your account.');
    }

    // Check if refresh is already in progress for this connection
    const lockKey = `youtube-${connection.id}`;
    if (this.tokenRefreshLocks.has(lockKey)) {
      // Wait for the in-progress refresh to complete
      logger.info('YouTube: Waiting for in-progress token refresh', { connectionId: connection.id });
      await this.tokenRefreshLocks.get(lockKey);
      // Re-fetch the connection to get the updated token
      const updatedConnection = PlatformConnection.getById(connection.id);
      return updatedConnection.access_token;
    }

    // Create a lock promise for this refresh
    let resolveLock;
    const lockPromise = new Promise((resolve) => { resolveLock = resolve; });
    this.tokenRefreshLocks.set(lockKey, lockPromise);

    try {
      const newTokens = await this.refreshAccessToken(connection.refresh_token);

      // Update connection with new tokens
      const expiresAt = new Date(Date.now() + (newTokens.expiry_date || 3600 * 1000));
      await PlatformConnection.update(connection.id, {
        access_token: newTokens.access_token,
        token_expires_at: expiresAt.toISOString(),
      });

      return newTokens.access_token;
    } finally {
      // Release the lock
      this.tokenRefreshLocks.delete(lockKey);
      resolveLock();
    }
  }
}

export default YouTubeService;
