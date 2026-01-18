// Platform OAuth2 Configuration
// Set these in your .env file or environment variables

export const platformConfig = {
  facebook: {
    clientId: process.env.FACEBOOK_CLIENT_ID,
    clientSecret: process.env.FACEBOOK_CLIENT_SECRET,
    redirectUri: process.env.FACEBOOK_REDIRECT_URI || 'http://localhost:3001/api/platforms/auth/facebook/callback',
    configId: process.env.FACEBOOK_CONFIG_ID || '901207125617600',
    scopes: ['email', 'pages_show_list', 'pages_manage_posts', 'pages_read_engagement'],
  },

  youtube: {
    clientId: process.env.YOUTUBE_CLIENT_ID,
    clientSecret: process.env.YOUTUBE_CLIENT_SECRET,
    redirectUri: process.env.YOUTUBE_REDIRECT_URI || 'http://localhost:3001/api/platforms/auth/youtube/callback',
    scopes: [
      'https://www.googleapis.com/auth/youtube.force-ssl',
      'https://www.googleapis.com/auth/youtube',
      'https://www.googleapis.com/auth/userinfo.profile',
      'https://www.googleapis.com/auth/userinfo.email',
    ],
  },

  twitch: {
    clientId: process.env.TWITCH_CLIENT_ID,
    clientSecret: process.env.TWITCH_CLIENT_SECRET,
    redirectUri: process.env.TWITCH_REDIRECT_URI || 'http://localhost:3001/api/platforms/auth/twitch/callback',
    scopes: ['user:read:email', 'channel:manage:broadcast', 'channel:read:stream_key'],
  },

  kick: {
    clientId: process.env.KICK_CLIENT_ID,
    clientSecret: process.env.KICK_CLIENT_SECRET,
    redirectUri: process.env.KICK_REDIRECT_URI || 'http://localhost:3001/api/platforms/auth/kick/callback',
    scopes: ['user:read', 'channel:read', 'streamkey:read'],
  },

  // Base URLs
  baseUrl: process.env.BASE_URL || 'http://localhost:3001',
};

export default platformConfig;
