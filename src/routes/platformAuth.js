import express from 'express';
import { authenticateToken } from '../middleware/auth.js';
import { checkPlanLimit } from '../middleware/permissions.js';
import FacebookService from '../services/FacebookService.js';
import YouTubeService from '../services/YouTubeService.js';
import TwitchService from '../services/TwitchService.js';
import PlatformConnection from '../models/PlatformConnection.js';
import User from '../models/User.js';
import logger from '../utils/logger.js';

const router = express.Router();

// ==================== FACEBOOK ====================

// Initiate Facebook OAuth
router.get('/facebook', authenticateToken, (req, res) => {
  try {
    const state = JSON.stringify({ userId: req.user.id });
    const authUrl = FacebookService.getAuthUrl(state);
    res.json({ authUrl });
  } catch (error) {
    logger.error('Failed to generate Facebook auth URL', { error: error.message });
    res.status(500).json({ error: 'Failed to initiate Facebook authentication' });
  }
});

// Facebook OAuth callback
router.get('/facebook/callback', async (req, res) => {
  const { code, state } = req.query;

  if (!code) {
    return res.redirect(`${process.env.FRONTEND_URL || 'http://localhost:3000'}/settings?error=facebook_auth_failed`);
  }

  try {
    const { userId } = JSON.parse(state);

    // Exchange code for access token
    const tokenData = await FacebookService.getAccessToken(code);

    // Get long-lived token
    const longLivedToken = await FacebookService.getLongLivedToken(tokenData.access_token);

    // Get user info
    const userInfo = await FacebookService.getUserInfo(longLivedToken.access_token);

    // Get user's pages
    const pages = await FacebookService.getPages(longLivedToken.access_token);
    const firstPage = pages.length > 0 ? pages[0] : null;

    // Calculate token expiry (Facebook long-lived tokens last ~60 days)
    const expiresAt = new Date(Date.now() + (longLivedToken.expires_in || 5184000) * 1000);

    // Delete existing Facebook connection for this user
    await PlatformConnection.deleteByPlatformAndUser('facebook', userId);

    // Save connection with page information and all available pages
    await PlatformConnection.create({
      platform: 'facebook',
      user_id: userId,
      access_token: longLivedToken.access_token,
      token_expires_at: expiresAt.toISOString(),
      platform_user_id: userInfo.id,
      platform_user_name: userInfo.name,
      platform_user_email: userInfo.email,
      platform_page_id: firstPage?.id,
      platform_page_name: firstPage?.name,
      available_pages: JSON.stringify(pages.map(page => ({
        id: page.id,
        name: page.name,
        access_token: page.access_token
      }))),
      scopes: ['public_profile', 'pages_show_list', 'pages_manage_posts', 'publish_video'],
    });

    logger.info('Facebook account connected', { userId, fbUserId: userInfo.id });

    res.redirect(`${process.env.FRONTEND_URL || 'http://localhost:3000'}/settings?tab=platforms&success=facebook_connected`);
  } catch (error) {
    logger.error('Facebook OAuth callback failed', { error: error.message });
    res.redirect(`${process.env.FRONTEND_URL || 'http://localhost:3000'}/settings?tab=platforms&error=facebook_auth_failed`);
  }
});

// ==================== YOUTUBE ====================

// Initiate YouTube OAuth
router.get('/youtube', authenticateToken, (req, res) => {
  try {
    const state = JSON.stringify({ userId: req.user.id });
    const authUrl = YouTubeService.getAuthUrl(state);
    res.json({ authUrl });
  } catch (error) {
    logger.error('Failed to generate YouTube auth URL', { error: error.message });
    res.status(500).json({ error: 'Failed to initiate YouTube authentication' });
  }
});

// YouTube OAuth callback
router.get('/youtube/callback', async (req, res) => {
  const { code, state } = req.query;

  console.log('=== YouTube OAuth callback received ===', { hasCode: !!code, hasState: !!state, code: code?.substring(0, 20) + '...', state });
  logger.info('YouTube OAuth callback received', { hasCode: !!code, hasState: !!state });

  if (!code) {
    console.log('=== YouTube OAuth - no code provided ===');
    logger.warn('YouTube OAuth callback - no code provided');
    return res.redirect(`${process.env.FRONTEND_URL || 'http://localhost:3000'}/settings?error=youtube_auth_failed`);
  }

  try {
    const { userId } = JSON.parse(state);
    console.log('=== YouTube OAuth - parsed state ===', { userId });
    logger.info('YouTube OAuth - parsed state', { userId });

    // Exchange code for tokens
    console.log('=== YouTube OAuth - exchanging code for tokens ===');
    logger.info('YouTube OAuth - exchanging code for tokens');
    const tokens = await YouTubeService.getTokens(code);
    console.log('=== YouTube OAuth - tokens received ===', { hasAccessToken: !!tokens.access_token, hasRefreshToken: !!tokens.refresh_token });
    logger.info('YouTube OAuth - tokens received', { hasAccessToken: !!tokens.access_token, hasRefreshToken: !!tokens.refresh_token });

    // Get user info
    console.log('=== YouTube OAuth - getting user info ===');
    logger.info('YouTube OAuth - getting user info');
    const userInfo = await YouTubeService.getUserInfo(tokens.access_token, tokens.refresh_token);
    console.log('=== YouTube OAuth - user info received ===', { userId: userInfo.id, userName: userInfo.name });
    logger.info('YouTube OAuth - user info received', { userId: userInfo.id, userName: userInfo.name });

    // Get channel info
    console.log('=== YouTube OAuth - getting channel info ===');
    logger.info('YouTube OAuth - getting channel info');
    const channelInfo = await YouTubeService.getChannelInfo(tokens.access_token, tokens.refresh_token);
    console.log('=== YouTube OAuth - channel info received ===', { channelId: channelInfo.id, channelName: channelInfo.title });
    logger.info('YouTube OAuth - channel info received', { channelId: channelInfo.id, channelName: channelInfo.title });

    // Calculate token expiry
    const expiresAt = new Date(tokens.expiry_date || Date.now() + 3600 * 1000);

    // Delete existing YouTube connection for this user
    await PlatformConnection.deleteByPlatformAndUser('youtube', userId);

    // Save connection
    console.log('=== YouTube OAuth - saving connection to database ===');
    logger.info('YouTube OAuth - saving connection to database');
    await PlatformConnection.create({
      platform: 'youtube',
      user_id: userId,
      access_token: tokens.access_token,
      refresh_token: tokens.refresh_token,
      token_expires_at: expiresAt.toISOString(),
      platform_user_id: userInfo.id,
      platform_user_name: userInfo.name,
      platform_user_email: userInfo.email,
      platform_channel_id: channelInfo.id,
      platform_channel_name: channelInfo.title,
      scopes: tokens.scope ? tokens.scope.split(' ') : [],
    });

    console.log('=== YouTube account connected successfully ===', { userId, channelId: channelInfo.id });
    logger.info('YouTube account connected successfully', { userId, channelId: channelInfo.id });

    res.redirect(`${process.env.FRONTEND_URL || 'http://localhost:3000'}/settings?tab=platforms&success=youtube_connected`);
  } catch (error) {
    console.error('=== YouTube OAuth callback FAILED ===', { error: error.message, stack: error.stack });
    logger.error('YouTube OAuth callback failed', { error: error.message, stack: error.stack });
    res.redirect(`${process.env.FRONTEND_URL || 'http://localhost:3000'}/settings?tab=platforms&error=youtube_auth_failed`);
  }
});

// ==================== TWITCH ====================

// Initiate Twitch OAuth
router.get('/twitch', authenticateToken, (req, res) => {
  try {
    const state = JSON.stringify({ userId: req.user.id });
    const authUrl = TwitchService.getAuthUrl(state);
    res.json({ authUrl });
  } catch (error) {
    logger.error('Failed to generate Twitch auth URL', { error: error.message });
    res.status(500).json({ error: 'Failed to initiate Twitch authentication' });
  }
});

// Twitch OAuth callback
router.get('/twitch/callback', async (req, res) => {
  const { code, state } = req.query;

  if (!code) {
    return res.redirect(`${process.env.FRONTEND_URL || 'http://localhost:3000'}/settings?error=twitch_auth_failed`);
  }

  try {
    const { userId } = JSON.parse(state);

    // Exchange code for access token
    const tokenData = await TwitchService.getAccessToken(code);

    // Get user info
    const userInfo = await TwitchService.getUserInfo(tokenData.access_token);

    // Calculate token expiry
    const expiresAt = new Date(Date.now() + (tokenData.expires_in || 3600) * 1000);

    // Delete existing Twitch connection for this user
    await PlatformConnection.deleteByPlatformAndUser('twitch', userId);

    // Save connection
    await PlatformConnection.create({
      platform: 'twitch',
      user_id: userId,
      access_token: tokenData.access_token,
      refresh_token: tokenData.refresh_token,
      token_expires_at: expiresAt.toISOString(),
      platform_user_id: userInfo.id,
      platform_user_name: userInfo.display_name,
      platform_user_email: userInfo.email,
      platform_channel_id: userInfo.id, // Twitch user ID is same as channel ID
      platform_channel_name: userInfo.login,
      scopes: tokenData.scope || [],
    });

    logger.info('Twitch account connected', { userId, twitchUserId: userInfo.id });

    res.redirect(`${process.env.FRONTEND_URL || 'http://localhost:3000'}/settings?tab=platforms&success=twitch_connected`);
  } catch (error) {
    logger.error('Twitch OAuth callback failed', { error: error.message });
    res.redirect(`${process.env.FRONTEND_URL || 'http://localhost:3000'}/settings?tab=platforms&error=twitch_auth_failed`);
  }
});

export default router;
