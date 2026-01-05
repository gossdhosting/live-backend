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

// Get single channel info
router.get('/channels/:id', (req, res) => {
  try {
    const { id } = req.params;
    const channel = Channel.findById(id);

    if (!channel || channel.status !== 'running') {
      return res.status(404).json({ error: 'Channel not found or not streaming' });
    }

    res.json({
      channel: {
        id: channel.id,
        name: channel.name,
        description: channel.description,
        hls_url: `/hls/channel_${channel.id}/index.m3u8`,
        created_at: channel.created_at,
      },
    });
  } catch (error) {
    res.status(500).json({ error: 'Internal server error' });
  }
});

export default router;
