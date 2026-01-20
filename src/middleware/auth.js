import jwt from 'jsonwebtoken';
import User from '../models/User.js';

const JWT_SECRET = process.env.JWT_SECRET || 'your-secret-key';

// Generate JWT token
export const generateToken = (userId) => {
  return jwt.sign({ userId }, JWT_SECRET, { expiresIn: '7d' });
};

// Verify JWT token
export const verifyToken = (token) => {
  try {
    return jwt.verify(token, JWT_SECRET);
  } catch (error) {
    return null;
  }
};

// Authentication middleware
export const authenticateToken = async (req, res, next) => {
  const authHeader = req.headers['authorization'];
  const token = authHeader && authHeader.split(' ')[1]; // Bearer TOKEN

  // Enhanced logging for WebRTC endpoints
  const isWebRTC = req.path.includes('/webrtc');
  if (isWebRTC) {
    console.log('[WebRTC Auth] Request to:', req.method, req.path);
    console.log('[WebRTC Auth] Auth header present:', !!authHeader);
    console.log('[WebRTC Auth] Token extracted:', token ? 'yes (length: ' + token.length + ')' : 'no');
  }

  if (!token) {
    if (isWebRTC) console.log('[WebRTC Auth] REJECTED: No token provided');
    return res.status(401).json({ error: 'Access token required' });
  }

  const decoded = verifyToken(token);

  if (!decoded) {
    if (isWebRTC) {
      console.log('[WebRTC Auth] REJECTED: Token verification failed');
      console.log('[WebRTC Auth] Token first 20 chars:', token.substring(0, 20));
      console.log('[WebRTC Auth] JWT_SECRET configured:', !!JWT_SECRET);
    }
    return res.status(403).json({ error: 'Invalid or expired token' });
  }

  if (isWebRTC) {
    console.log('[WebRTC Auth] Token decoded successfully, userId:', decoded.userId);
  }

  // Attach user info to request
  const user = await User.findById(decoded.userId);

  if (!user) {
    if (isWebRTC) console.log('[WebRTC Auth] REJECTED: User not found for userId:', decoded.userId);
    return res.status(403).json({ error: 'User not found' });
  }

  if (isWebRTC) {
    console.log('[WebRTC Auth] SUCCESS: User authenticated:', user.username, 'role:', user.role);
  }

  req.user = user;
  next();
};

// Admin role check
export const requireAdmin = (req, res, next) => {
  if (req.user.role !== 'admin') {
    return res.status(403).json({ error: 'Admin access required' });
  }
  next();
};

// Aliases for compatibility
export const auth = authenticateToken;
export const adminOnly = requireAdmin;
