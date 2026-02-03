import express from 'express';
import Channel from '../models/Channel.js';

const router = express.Router();

// Public API for Flutter app - Get all active channels
router.get('/channels', (req, res) => {
  try {
    const channels = Channel.findAll();

    // Only return running channels with minimal info
    const publicChannels = channels
      .filter((channel) => channel.status === 'running')
      .map((channel) => ({
        id: channel.id,
        name: channel.name,
        description: channel.description,
        hls_url: `/hls/channel_${channel.id}/index.m3u8`,
        created_at: channel.created_at,
      }));

    res.json({ channels: publicChannels });
  } catch (error) {
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Get single channel info (used by embed player to check stream status)
router.get('/channels/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const channel = await Channel.findById(parseInt(id));

    if (!channel) {
      return res.status(404).json({ error: 'Channel not found' });
    }

    // Return channel info with status - embed player needs this to handle offline/online states
    res.json({
      id: channel.id,
      name: channel.name || 'Untitled Channel',
      description: channel.description || '',
      status: channel.status || 'stopped',
      hls_url: `/hls/channel_${channel.id}/index.m3u8`,
      created_at: channel.created_at,
    });
  } catch (error) {
    console.error('Public API error:', error);
    res.status(500).json({ error: 'Internal server error', details: error.message });
  }
});

export default router;
