// Platform OAuth2 Configuration
// Set these in your .env file or environment variables

export const platformConfig = {
  facebook: {
    clientId: process.env.FACEBOOK_CLIENT_ID,
    clientSecret: process.env.FACEBOOK_CLIENT_SECRET,
    redirectUri: process.env.FACEBOOK_REDIRECT_URI || 'http://localhost:3001/api/platforms/auth/facebook/callback',
    scopes: ['public_profile', 'pages_show_list', 'pages_manage_posts', 'publish_video', 'pages_read_engagement'],
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

  // Base URLs
  baseUrl: process.env.BASE_URL || 'http://localhost:3001',
};

export default platformConfig;
