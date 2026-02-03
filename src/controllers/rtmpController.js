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

    // Allow RTMP input for:
    // 1. Channels configured for RTMP input (OBS/vMix)
    // 2. WebRTC channels (webcam/screen share) - they use nginx-rtmp as intermediate buffer
    const allowedInputTypes = ['rtmp', 'webcam', 'screen'];
    if (!allowedInputTypes.includes(channel.input_type)) {
      logger.warn('RTMP auth failed: channel not configured for RTMP/WebRTC input', {
        streamKey,
        channelId: channel.id,
        inputType: channel.input_type
      });
      return res.status(403).send('Forbidden');
    }

    // Mark channel as receiving RTMP input (only for actual RTMP channels)
    if (channel.input_type === 'rtmp') {
      await Channel.setRtmpInputConnected(channel.id, true);
    }

    logger.info('RTMP authentication successful', {
      streamKey,
      channelId: channel.id,
      channelName: channel.name,
      inputType: channel.input_type
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
      // Only handle RTMP input disconnection for actual RTMP channels
      // WebRTC channels manage their own state
      if (channel.input_type === 'rtmp') {
        // Mark channel as no longer receiving RTMP input
        await Channel.setRtmpInputConnected(channel.id, false);

        // Update channel status if it was running
        if (channel.status === 'running') {
          await Channel.updateStatus(channel.id, 'stopped', null, 'RTMP stream disconnected');
          await Channel.addLog(channel.id, 'info', 'RTMP input stream disconnected');
          logger.info('Channel status updated after RTMP disconnect', {
            channelId: channel.id,
            streamKey
          });
        }
      } else {
        logger.info('RTMP stream ended for WebRTC channel (no status change)', {
          channelId: channel.id,
          inputType: channel.input_type,
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
