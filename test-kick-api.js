import axios from 'axios';
import dotenv from 'dotenv';
import pg from 'pg';

const { Client } = pg;

// Load environment variables
dotenv.config();

console.log('🚀 Kick API Test Script\n');
console.log('='.repeat(60));

async function testKickAPI() {
  // Connect to PostgreSQL database
  const client = new Client({
    host: process.env.PG_HOST || '45.56.163.33',
    port: process.env.PG_PORT || 5432,
    database: process.env.PG_DATABASE || 'streaming',
    user: process.env.PG_USER || 'streamadmin',
    password: process.env.PG_PASSWORD || 'Sohail@123',
  });

  try {
    // Connect to database
    console.log('\n📊 Step 1: Connecting to PostgreSQL database...');
    await client.connect();
    console.log('✅ Connected to database');

    // Get the Kick connection from database
    console.log('\n📊 Step 2: Fetching Kick connection for user 3...');
    const result = await client.query(
      'SELECT access_token, platform_user_name, platform_user_id, token_expires_at FROM platform_connections WHERE user_id = $1 AND platform = $2 LIMIT 1',
      [3, 'kick']
    );

    if (result.rows.length === 0) {
      console.error('❌ No Kick connection found for user 3');
      console.log('\n💡 Make sure the user has connected their Kick account first');
      return;
    }

    const connection = result.rows[0];
    const accessToken = connection.access_token;
    const slug = connection.platform_user_name;
    const platformUserId = connection.platform_user_id;
    const tokenExpires = connection.token_expires_at;

    console.log('✅ Found Kick connection:');
    console.log(`   - Platform Username: ${slug}`);
    console.log(`   - Platform User ID: ${platformUserId}`);
    console.log(`   - Has Access Token: ${!!accessToken}`);
    console.log(`   - Token Length: ${accessToken?.length || 0} characters`);
    console.log(`   - Token Expires: ${tokenExpires}`);

    // Test 1: Get user info
    console.log('\n' + '='.repeat(60));
    console.log('📡 Step 2: Testing GET /public/v1/users endpoint');
    console.log('='.repeat(60));
    try {
      const userResponse = await axios.get('https://api.kick.com/public/v1/users', {
        headers: {
          'Authorization': `Bearer ${accessToken}`,
          'Accept': 'application/json',
        },
      });
      console.log('✅ User info retrieved successfully:');
      console.log(JSON.stringify(userResponse.data, null, 2));
    } catch (error) {
      console.error('❌ Failed to get user info:');
      console.error(`   Status: ${error.response?.status}`);
      console.error(`   Message: ${error.response?.data?.message || error.message}`);
      console.error(`   Response:`, JSON.stringify(error.response?.data, null, 2));
    }

    // Test 2: Get channel info
    console.log('\n' + '='.repeat(60));
    console.log(`📡 Step 3: Testing GET /public/v1/channels?slug=${slug}`);
    console.log('='.repeat(60));
    try {
      const params = new URLSearchParams({ slug });
      const channelResponse = await axios.get(`https://api.kick.com/public/v1/channels?${params.toString()}`, {
        headers: {
          'Authorization': `Bearer ${accessToken}`,
          'Accept': 'application/json',
        },
      });
      console.log('✅ Channel info retrieved successfully:');
      console.log(JSON.stringify(channelResponse.data, null, 2));

      const channelData = channelResponse.data.data?.[0];
      if (channelData) {
        console.log('\n📋 Channel Details:');
        console.log(`   - Slug: ${channelData.slug}`);
        console.log(`   - Broadcaster User ID: ${channelData.broadcaster_user_id}`);
        console.log(`   - Has Stream Object: ${!!channelData.stream}`);
        if (channelData.stream) {
          console.log(`   - Stream URL: ${channelData.stream.url || 'NOT FOUND'}`);
          console.log(`   - Stream Key: ${channelData.stream.key ? '***HIDDEN***' : 'NOT FOUND'}`);
        }
      }
    } catch (error) {
      console.error('❌ Failed to get channel info:');
      console.error(`   Status: ${error.response?.status}`);
      console.error(`   Message: ${error.response?.data?.message || error.message}`);
      console.error(`   Response:`, JSON.stringify(error.response?.data, null, 2));
    }

    // Test 3: Get publish token (stream key)
    console.log('\n' + '='.repeat(60));
    console.log('📡 Step 4: Testing GET /stream/publish_token endpoint');
    console.log('='.repeat(60));
    try {
      const tokenResponse = await axios.get('https://api.kick.com/stream/publish_token', {
        headers: {
          'Authorization': `Bearer ${accessToken}`,
          'Accept': 'application/json',
        },
      });
      console.log('✅ Publish token retrieved successfully:');
      console.log(JSON.stringify({
        ...tokenResponse.data,
        token: tokenResponse.data.token ? '***HIDDEN***' : undefined
      }, null, 2));

      console.log('\n📋 Stream Credentials:');
      console.log(`   - RTMP URL: ${tokenResponse.data.url || 'NOT FOUND'}`);
      console.log(`   - Stream Key: ${tokenResponse.data.token ? '***HIDDEN (length: ' + tokenResponse.data.token.length + ')***' : 'NOT FOUND'}`);
    } catch (error) {
      console.error('❌ Failed to get publish token:');
      console.error(`   Status: ${error.response?.status}`);
      console.error(`   Message: ${error.response?.data?.message || error.message}`);
      console.error(`   Response:`, JSON.stringify(error.response?.data, null, 2));
    }

    // Test 4: Alternative endpoint - /stream/info
    console.log('\n' + '='.repeat(60));
    console.log('📡 Step 5: Testing GET /stream/info endpoint (alternative)');
    console.log('='.repeat(60));
    try {
      const streamInfoResponse = await axios.get('https://api.kick.com/stream/info', {
        headers: {
          'Authorization': `Bearer ${accessToken}`,
          'Accept': 'application/json',
        },
      });
      console.log('✅ Stream info retrieved successfully:');
      console.log(JSON.stringify(streamInfoResponse.data, null, 2));
    } catch (error) {
      console.error('❌ Failed to get stream info:');
      console.error(`   Status: ${error.response?.status}`);
      console.error(`   Message: ${error.response?.data?.message || error.message}`);
      console.error(`   Response:`, JSON.stringify(error.response?.data, null, 2));
    }

    // Test 5: Try without public prefix
    console.log('\n' + '='.repeat(60));
    console.log('📡 Step 6: Testing GET /v1/channels (without /public prefix)');
    console.log('='.repeat(60));
    try {
      const params = new URLSearchParams({ slug });
      const altChannelResponse = await axios.get(`https://api.kick.com/v1/channels?${params.toString()}`, {
        headers: {
          'Authorization': `Bearer ${accessToken}`,
          'Accept': 'application/json',
        },
      });
      console.log('✅ Channel info (v1) retrieved successfully:');
      console.log(JSON.stringify(altChannelResponse.data, null, 2));
    } catch (error) {
      console.error('❌ Failed to get channel info from v1:');
      console.error(`   Status: ${error.response?.status}`);
      console.error(`   Message: ${error.response?.data?.message || error.message}`);
    }

  } catch (error) {
    console.error('\n❌ Test script error:', error.message);
    console.error(error.stack);
  } finally {
    await client.end();
  }
}

// Run the tests
console.log(`\n🔧 Configuration:`);
console.log(`   - Kick Client ID: ${process.env.KICK_CLIENT_ID ? '***CONFIGURED***' : 'NOT SET'}`);
console.log(`   - Kick Client Secret: ${process.env.KICK_CLIENT_SECRET ? '***CONFIGURED***' : 'NOT SET'}`);
console.log(`   - Kick Redirect URI: ${process.env.KICK_REDIRECT_URI || 'NOT SET'}`);

testKickAPI()
  .then(() => {
    console.log('\n' + '='.repeat(60));
    console.log('✅ Test completed');
    console.log('='.repeat(60));
  })
  .catch(error => {
    console.error('\n❌ Test failed:', error);
  });
