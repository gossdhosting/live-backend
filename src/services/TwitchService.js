import axios from 'axios';
import platformConfig from '../config/platforms.js';
import PlatformConnection from '../models/PlatformConnection.js';
import logger from '../utils/logger.js';

class TwitchService {
  // Generate OAuth2 authorization URL
  static getAuthUrl(state = '') {
    const config = platformConfig.twitch;
    const params = new URLSearchParams({
      client_id: config.clientId,
      redirect_uri: config.redirectUri,
      response_type: 'code',
      scope: config.scopes.join(' '),
      state: state,
      force_verify: 'true',
    });

    return `https://id.twitch.tv/oauth2/authorize?${params.toString()}`;
  }

  // Exchange authorization code for access token
  static async getAccessToken(code) {
    const config = platformConfig.twitch;

    try {
      const response = await axios.post('https://id.twitch.tv/oauth2/token', {
        client_id: config.clientId,
        client_secret: config.clientSecret,
        code: code,
        grant_type: 'authorization_code',
        redirect_uri: config.redirectUri,
      });

      return response.data;
    } catch (error) {
      logger.error('Twitch: Failed to get access token', { error: error.response?.data || error.message });
      throw new Error('Failed to get Twitch access token');
    }
  }

  // Get user info
  static async getUserInfo(accessToken) {
    const config = platformConfig.twitch;

    try {
      const response = await axios.get('https://api.twitch.tv/helix/users', {
        headers: {
          'Client-ID': config.clientId,
          'Authorization': `Bearer ${accessToken}`,
        },
      });

      if (!response.data.data || response.data.data.length === 0) {
        throw new Error('No user data returned');
      }

      const user = response.data.data[0];
      return {
        id: user.id,
        login: user.login,
        display_name: user.display_name,
        email: user.email,
        profile_image_url: user.profile_image_url,
      };
    } catch (error) {
      logger.error('Twitch: Failed to get user info', { error: error.response?.data || error.message });
      throw new Error('Failed to get Twitch user info');
    }
  }

  // Get channel information
  static async getChannelInfo(accessToken, broadcasterId) {
    const config = platformConfig.twitch;

    try {
      const response = await axios.get('https://api.twitch.tv/helix/channels', {
        params: {
          broadcaster_id: broadcasterId,
        },
        headers: {
          'Client-ID': config.clientId,
          'Authorization': `Bearer ${accessToken}`,
        },
      });

      if (!response.data.data || response.data.data.length === 0) {
        throw new Error('Channel not found');
      }

      return response.data.data[0];
    } catch (error) {
      logger.error('Twitch: Failed to get channel info', { error: error.response?.data || error.message });
      throw new Error('Failed to get Twitch channel info');
    }
  }

  // Update channel information (title, category, etc.)
  static async updateChannelInfo(accessToken, broadcasterId, title, categoryId = null) {
    const config = platformConfig.twitch;

    const payload = {
      title: title,
    };

    if (categoryId) {
      payload.game_id = categoryId;
    }

    try {
      await axios.patch(
        'https://api.twitch.tv/helix/channels',
        payload,
        {
          params: {
            broadcaster_id: broadcasterId,
          },
          headers: {
            'Client-ID': config.clientId,
            'Authorization': `Bearer ${accessToken}`,
            'Content-Type': 'application/json',
          },
        }
      );

      return { success: true };
    } catch (error) {
      logger.error('Twitch: Failed to update channel info', { error: error.response?.data || error.message });
      throw new Error(error.response?.data?.message || 'Failed to update Twitch channel');
    }
  }

  // Get stream key (requires special permission)
  static async getStreamKey(accessToken, broadcasterId) {
    const config = platformConfig.twitch;

    try {
      const response = await axios.get('https://api.twitch.tv/helix/streams/key', {
        params: {
          broadcaster_id: broadcasterId,
        },
        headers: {
          'Client-ID': config.clientId,
          'Authorization': `Bearer ${accessToken}`,
        },
      });

      if (!response.data.data || response.data.data.length === 0) {
        throw new Error('Stream key not found');
      }

      return response.data.data[0].stream_key;
    } catch (error) {
      logger.error('Twitch: Failed to get stream key', { error: error.response?.data || error.message });
      throw new Error('Failed to get Twitch stream key. Make sure you have the required permissions.');
    }
  }

  // Get Twitch RTMP ingest servers
  static async getIngestServers() {
    try {
      const response = await axios.get('https://ingest.twitch.tv/ingests');
      return response.data.ingests || [];
    } catch (error) {
      logger.error('Twitch: Failed to get ingest servers', { error: error.message });
      // Return default server if API fails
      return [{ url_template: 'rtmp://live.twitch.tv/app', name: 'Default' }];
    }
  }

  // Setup stream for channel
  static async setupStream(accessToken, broadcasterId, title, categoryId = null) {
    try {
      // Update channel metadata
      await this.updateChannelInfo(accessToken, broadcasterId, title, categoryId);

      // Get stream key
      const streamKey = await this.getStreamKey(accessToken, broadcasterId);

      // Get best ingest server (or use default)
      const ingestServers = await this.getIngestServers();
      const rtmpUrl = ingestServers.length > 0
        ? ingestServers[0].url_template.replace('{stream_key}', '')
        : 'rtmp://live.twitch.tv/app';

      return {
        rtmp_url: rtmpUrl,
        stream_key: streamKey,
        dashboard_url: 'https://dashboard.twitch.tv/u/' + broadcasterId + '/stream-manager',
      };
    } catch (error) {
      logger.error('Twitch: Failed to setup stream', { error: error.message });
      throw error;
    }
  }

  // Get stream status
  static async getStreamStatus(accessToken, broadcasterId) {
    const config = platformConfig.twitch;

    try {
      const response = await axios.get('https://api.twitch.tv/helix/streams', {
        params: {
          user_id: broadcasterId,
        },
        headers: {
          'Client-ID': config.clientId,
          'Authorization': `Bearer ${accessToken}`,
        },
      });

      if (!response.data.data || response.data.data.length === 0) {
        return { is_live: false };
      }

      const stream = response.data.data[0];
      return {
        is_live: true,
        title: stream.title,
        viewer_count: stream.viewer_count,
        started_at: stream.started_at,
      };
    } catch (error) {
      logger.error('Twitch: Failed to get stream status', { error: error.response?.data || error.message });
      throw new Error('Failed to get stream status');
    }
  }

  // Refresh access token
  static async refreshAccessToken(refreshToken) {
    const config = platformConfig.twitch;

    try {
      const response = await axios.post('https://id.twitch.tv/oauth2/token', {
        client_id: config.clientId,
        client_secret: config.clientSecret,
        grant_type: 'refresh_token',
        refresh_token: refreshToken,
      });

      return response.data;
    } catch (error) {
      logger.error('Twitch: Failed to refresh token', { error: error.response?.data || error.message });
      throw new Error('Failed to refresh Twitch token');
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

    const newTokens = await this.refreshAccessToken(connection.refresh_token);

    // Update connection with new tokens
    const expiresAt = new Date(Date.now() + newTokens.expires_in * 1000);
    await PlatformConnection.update(connection.id, {
      access_token: newTokens.access_token,
      refresh_token: newTokens.refresh_token,
      token_expires_at: expiresAt.toISOString(),
    });

    return newTokens.access_token;
  }

  // Validate token
  static async validateToken(accessToken) {
    try {
      const response = await axios.get('https://id.twitch.tv/oauth2/validate', {
        headers: {
          'Authorization': `Bearer ${accessToken}`,
        },
      });

      return response.data;
    } catch (error) {
      logger.error('Twitch: Token validation failed', { error: error.response?.data || error.message });
      return null;
    }
  }
}

export default TwitchService;
