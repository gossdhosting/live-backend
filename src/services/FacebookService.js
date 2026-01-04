import axios from 'axios';
import platformConfig from '../config/platforms.js';
import PlatformConnection from '../models/PlatformConnection.js';
import logger from '../utils/logger.js';

class FacebookService {
  // Generate OAuth2 authorization URL
  static getAuthUrl(state = '') {
    const config = platformConfig.facebook;
    const params = new URLSearchParams({
      client_id: config.clientId,
      redirect_uri: config.redirectUri,
      scope: config.scopes.join(','),
      response_type: 'code',
      state: state,
    });

    return `https://www.facebook.com/v18.0/dialog/oauth?${params.toString()}`;
  }

  // Exchange authorization code for access token
  static async getAccessToken(code) {
    const config = platformConfig.facebook;

    try {
      const response = await axios.get('https://graph.facebook.com/v18.0/oauth/access_token', {
        params: {
          client_id: config.clientId,
          client_secret: config.clientSecret,
          redirect_uri: config.redirectUri,
          code: code,
        },
      });

      return response.data;
    } catch (error) {
      logger.error('Facebook: Failed to get access token', { error: error.response?.data || error.message });
      throw new Error('Failed to get Facebook access token');
    }
  }

  // Get long-lived access token
  static async getLongLivedToken(shortToken) {
    const config = platformConfig.facebook;

    try {
      const response = await axios.get('https://graph.facebook.com/v18.0/oauth/access_token', {
        params: {
          grant_type: 'fb_exchange_token',
          client_id: config.clientId,
          client_secret: config.clientSecret,
          fb_exchange_token: shortToken,
        },
      });

      return response.data;
    } catch (error) {
      logger.error('Facebook: Failed to get long-lived token', { error: error.response?.data || error.message });
      throw new Error('Failed to get long-lived token');
    }
  }

  // Get user info
  static async getUserInfo(accessToken) {
    try {
      const response = await axios.get('https://graph.facebook.com/v18.0/me', {
        params: {
          fields: 'id,name,email',
          access_token: accessToken,
        },
      });

      return response.data;
    } catch (error) {
      logger.error('Facebook: Failed to get user info', { error: error.response?.data || error.message });
      throw new Error('Failed to get user info');
    }
  }

  // Get user's pages
  static async getPages(accessToken) {
    try {
      const response = await axios.get('https://graph.facebook.com/v18.0/me/accounts', {
        params: {
          access_token: accessToken,
        },
      });

      return response.data.data || [];
    } catch (error) {
      logger.error('Facebook: Failed to get pages', { error: error.response?.data || error.message });
      throw new Error('Failed to get Facebook pages');
    }
  }

  // Create live video on a page
  static async createLiveVideo(pageId, pageAccessToken, title, description) {
    try {
      const response = await axios.post(
        `https://graph.facebook.com/v18.0/${pageId}/live_videos`,
        {
          title: title,
          description: description,
          status: 'LIVE_NOW',
        },
        {
          params: {
            access_token: pageAccessToken,
          },
        }
      );

      return {
        stream_id: response.data.id,
        rtmp_url: response.data.secure_stream_url,
        stream_key: '', // Facebook combines URL and key in secure_stream_url
        dashboard_url: response.data.permalink_url,
      };
    } catch (error) {
      logger.error('Facebook: Failed to create live video', { error: error.response?.data || error.message });
      throw new Error(error.response?.data?.error?.message || 'Failed to create Facebook live video');
    }
  }

  // End live video
  static async endLiveVideo(videoId, accessToken) {
    try {
      const response = await axios.post(
        `https://graph.facebook.com/v18.0/${videoId}`,
        {
          end_live_video: true,
        },
        {
          params: {
            access_token: accessToken,
          },
        }
      );

      return response.data;
    } catch (error) {
      logger.error('Facebook: Failed to end live video', { error: error.response?.data || error.message });
      throw new Error('Failed to end Facebook live video');
    }
  }

  // Get live video status
  static async getLiveVideoStatus(videoId, accessToken) {
    try {
      const response = await axios.get(
        `https://graph.facebook.com/v18.0/${videoId}`,
        {
          params: {
            fields: 'id,title,description,status,live_views,permalink_url',
            access_token: accessToken,
          },
        }
      );

      return response.data;
    } catch (error) {
      logger.error('Facebook: Failed to get live video status', { error: error.response?.data || error.message });
      throw new Error('Failed to get live video status');
    }
  }

  // Refresh token if needed
  static async refreshTokenIfNeeded(connection) {
    if (!PlatformConnection.isTokenExpired(connection)) {
      return connection.access_token;
    }

    // Facebook long-lived tokens don't have a refresh mechanism
    // User needs to re-authenticate
    logger.warn('Facebook token expired, user needs to re-authenticate', { connectionId: connection.id });
    throw new Error('Facebook token expired. Please reconnect your account.');
  }
}

export default FacebookService;
