// Validate YouTube URL
export const isValidYouTubeUrl = (url) => {
  if (!url || typeof url !== 'string') return false;

  // YouTube URL patterns
  const patterns = [
    /^(https?:\/\/)?(www\.)?(youtube\.com\/watch\?v=|youtu\.be\/)[\w-]+/,
    /^(https?:\/\/)?(www\.)?youtube\.com\/live\/[\w-]+/,
    /^(https?:\/\/)?(www\.)?youtube\.com\/embed\/[\w-]+/,
  ];

  return patterns.some((pattern) => pattern.test(url));
};

// Sanitize input to prevent command injection
export const sanitizeInput = (input) => {
  if (!input || typeof input !== 'string') return '';

  // Remove dangerous characters
  return input.replace(/[;&|`$(){}[\]<>'"\\]/g, '');
};

// Validate channel name
export const isValidChannelName = (name) => {
  if (!name || typeof name !== 'string') return false;
  return name.length >= 2 && name.length <= 100;
};

// Validate email
export const isValidEmail = (email) => {
  if (!email || typeof email !== 'string') return false;
  const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  return emailRegex.test(email);
};

// Validate RTMP URL
export const isValidRtmpUrl = (url) => {
  if (!url || typeof url !== 'string') return false;
  const rtmpPattern = /^rtmps?:\/\/.+/i;
  return rtmpPattern.test(url);
};

// Validate stream key (no special characters that could cause injection)
export const isValidStreamKey = (key) => {
  if (!key || typeof key !== 'string') return false;
  // Allow alphanumeric, dash, underscore, and some special chars
  const keyPattern = /^[a-zA-Z0-9_\-?=&]+$/;
  return keyPattern.test(key) && key.length >= 4 && key.length <= 200;
};

// Validate integer in range
export const isValidIntegerInRange = (value, min, max) => {
  const num = parseInt(value);
  return !isNaN(num) && num >= min && num <= max;
};

// Validate bitrate string (e.g., "4000k", "6000k")
export const isValidBitrate = (bitrate) => {
  if (!bitrate || typeof bitrate !== 'string') return false;
  const bitratePattern = /^[0-9]+k$/;
  if (!bitratePattern.test(bitrate)) return false;

  const value = parseInt(bitrate);
  return value >= 500 && value <= 50000; // 500k to 50000k
};

// Validate watermark position
export const isValidWatermarkPosition = (position) => {
  const validPositions = [
    'top-left', 'top-center', 'top-right',
    'center-left', 'center', 'center-right',
    'bottom-left', 'bottom-center', 'bottom-right'
  ];
  return validPositions.includes(position);
};

// Validate opacity (0-1)
export const isValidOpacity = (opacity) => {
  const num = parseFloat(opacity);
  return !isNaN(num) && num >= 0 && num <= 1;
};

// Validate scale (0.1-5.0)
export const isValidScale = (scale) => {
  const num = parseFloat(scale);
  return !isNaN(num) && num >= 0.1 && num <= 5.0;
};
