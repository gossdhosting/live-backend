import Channel from '../models/Channel.js';
import logger from '../utils/logger.js';

/**
 * RTMP Authentication Handler
 * Called by nginx-rtmp when a client tries to publish a stream
 *
 * nginx-rtmp sends POST request with form data:
 * - name: stream key (e.g., "1ECBA5F83")
 * - app: application name (e.g., "live")
 */
export const rtmpAuth = async (req, res) => {
  try {
    const streamKey = req.body.name;
    const app = req.body.app;

    logger.info('RTMP authentication attempt', { streamKey, app });

    if (!streamKey) {
      logger.warn('RTMP auth failed: no stream key provided');
      return res.status(403).send('Forbidden');
    }

    // Find channel by stream_key
    const channel = await Channel.findByStreamKey(streamKey);

    if (!channel) {
      logger.warn('RTMP auth failed: invalid stream key', { streamKey });
      return res.status(403).send('Forbidden');
    }

    // Check if channel is configured for RTMP, webcam, or screen input
    // Webcam/Screen streams use WebRTC bridge which pushes to nginx-rtmp internally
    if (channel.input_type !== 'rtmp' && channel.input_type !== 'webcam' && channel.input_type !== 'screen') {
      logger.warn('RTMP auth failed: channel not configured for RTMP, webcam, or screen input', {
        streamKey,
        channelId: channel.id,
        inputType: channel.input_type
      });
      return res.status(403).send('Forbidden');
    }

    logger.info('RTMP authentication successful', {
      streamKey,
      channelId: channel.id,
      channelName: channel.name
    });

    // Return 200 OK to allow the publish
    res.status(200).send('OK');
  } catch (error) {
    logger.error('RTMP authentication error', { error: error.message });
    res.status(500).send('Internal Server Error');
  }
};

/**
 * RTMP Publish Done Handler
 * Called by nginx-rtmp when a stream is stopped/disconnected
 */
export const rtmpPublishDone = async (req, res) => {
  try {
    const streamKey = req.body.name;
    const app = req.body.app;

    logger.info('RTMP stream ended', { streamKey, app });

    // Find channel
    const channel = await Channel.findByStreamKey(streamKey);

    if (channel) {
      // Update channel status if it was running
      if (channel.status === 'running') {
        await Channel.updateStatus(channel.id, 'stopped', null, 'RTMP stream disconnected');
        await Channel.addLog(channel.id, 'info', 'RTMP input stream disconnected');
        logger.info('Channel status updated after RTMP disconnect', {
          channelId: channel.id,
          streamKey
        });
      }
    }

    res.status(200).send('OK');
  } catch (error) {
    logger.error('RTMP publish done error', { error: error.message });
    res.status(500).send('Internal Server Error');
  }
};
