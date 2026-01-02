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
