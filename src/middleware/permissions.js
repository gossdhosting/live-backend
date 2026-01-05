import User from '../models/User.js';
import logger from '../utils/logger.js';

// Role hierarchy (higher = more permissions)
const ROLE_HIERARCHY = {
  admin: 3,
  user: 1
};

// Permission definitions
const PERMISSIONS = {
  // User management
  'users.view': ['admin'],
  'users.create': ['admin'],
  'users.edit': ['admin'],
  'users.delete': ['admin'],

  // Plan management
  'plans.view': ['admin'],
  'plans.create': ['admin'],
  'plans.edit': ['admin'],
  'plans.delete': ['admin'],

  // Channel management
  'channels.view_own': ['admin', 'user'],
  'channels.view_all': ['admin'],
  'channels.create': ['admin', 'user'],
  'channels.edit_own': ['admin', 'user'],
  'channels.edit_all': ['admin'],
  'channels.delete_own': ['admin', 'user'],
  'channels.delete_all': ['admin'],
  'channels.start_own': ['admin', 'user'],
  'channels.start_all': ['admin'],
  'channels.stop_own': ['admin', 'user'],
  'channels.stop_all': ['admin'],

  // Media management
  'media.view_own': ['admin', 'user'],
  'media.view_all': ['admin'],
  'media.upload': ['admin', 'user'],
  'media.delete_own': ['admin', 'user'],
  'media.delete_all': ['admin'],

  // Platform connections
  'platforms.connect': ['admin', 'user'],
  'platforms.view_own': ['admin', 'user'],
  'platforms.view_all': ['admin'],
  'platforms.delete_own': ['admin', 'user'],
  'platforms.delete_all': ['admin'],

  // Settings
  'settings.view': ['admin'],
  'settings.edit': ['admin'],

  // System
  'system.stats': ['admin']
};

// Check if user has permission
export const hasPermission = (userRole, permission) => {
  const allowedRoles = PERMISSIONS[permission];
  if (!allowedRoles) return false;
  return allowedRoles.includes(userRole);
};

// Middleware to require specific permission
export const requirePermission = (permission) => {
  return (req, res, next) => {
    if (!req.user) {
      return res.status(401).json({ error: 'Authentication required' });
    }

    if (!hasPermission(req.user.role, permission)) {
      logger.warn('Permission denied', {
        userId: req.user.id,
        userRole: req.user.role,
        requiredPermission: permission
      });
      return res.status(403).json({
        error: 'Permission denied',
        required_permission: permission
      });
    }

    next();
  };
};

// Middleware to require admin role
export const requireAdmin = (req, res, next) => {
  if (!req.user) {
    return res.status(401).json({ error: 'Authentication required' });
  }

  if (req.user.role !== 'admin') {
    logger.warn('Admin access denied', {
      userId: req.user.id,
      userRole: req.user.role
    });
    return res.status(403).json({ error: 'Admin access required' });
  }

  next();
};

// Middleware to check resource ownership
export const requireOwnership = (resourceType) => {
  return async (req, res, next) => {
    if (!req.user) {
      return res.status(401).json({ error: 'Authentication required' });
    }

    // Admins can access all resources
    if (req.user.role === 'admin') {
      return next();
    }

    const resourceId = req.params.id || req.params.channelId;

    if (!resourceId) {
      return res.status(400).json({ error: 'Resource ID required' });
    }

    try {
      let isOwner = false;

      switch (resourceType) {
        case 'channel': {
          const db = (await import('./database.js')).default;
          const channel = db.prepare('SELECT user_id FROM channels WHERE id = ?').get(resourceId);
          isOwner = channel && channel.user_id === req.user.id;
          break;
        }
        case 'media': {
          const db = (await import('./database.js')).default;
          const media = db.prepare('SELECT user_id FROM media_files WHERE id = ?').get(resourceId);
          isOwner = media && media.user_id === req.user.id;
          break;
        }
        case 'platform_connection': {
          const db = (await import('./database.js')).default;
          const connection = db.prepare('SELECT user_id FROM platform_connections WHERE id = ?').get(resourceId);
          isOwner = connection && connection.user_id === req.user.id;
          break;
        }
        default:
          return res.status(400).json({ error: 'Invalid resource type' });
      }

      if (!isOwner) {
        logger.warn('Ownership check failed', {
          userId: req.user.id,
          resourceType,
          resourceId
        });
        return res.status(403).json({ error: 'Access denied: not resource owner' });
      }

      next();
    } catch (error) {
      logger.error('Ownership check error', { error: error.message });
      return res.status(500).json({ error: 'Failed to verify ownership' });
    }
  };
};

// Middleware to check plan limits
export const checkPlanLimit = (limitType) => {
  return async (req, res, next) => {
    if (!req.user) {
      return res.status(401).json({ error: 'Authentication required' });
    }

    // Admins bypass plan limits
    if (req.user.role === 'admin') {
      return next();
    }

    try {
      const limits = await User.checkPlanLimits(req.user.id);

      if (!limits) {
        return res.status(500).json({ error: 'Failed to check plan limits' });
      }

      switch (limitType) {
        case 'stream':
          if (!limits.canCreate.stream) {
            return res.status(403).json({
              error: 'Concurrent stream limit reached',
              limit: limits.limits.max_concurrent_streams,
              current: limits.usage.concurrent_streams,
              plan: limits.user_plan
            });
          }
          break;

        case 'storage':
          if (!limits.canCreate.media) {
            return res.status(403).json({
              error: 'Storage limit reached',
              limit_mb: limits.limits.storage_limit_mb,
              used_mb: limits.usage.storage_mb,
              plan: limits.user_plan
            });
          }
          break;

        case 'watermark':
          if (!limits.canCreate.watermark) {
            return res.status(403).json({
              error: 'Custom watermark not available in your plan',
              plan: limits.user_plan
            });
          }
          break;

        default:
          return res.status(400).json({ error: 'Invalid limit type' });
      }

      // Attach limits to request for use in controller
      req.userLimits = limits;
      next();
    } catch (error) {
      logger.error('Plan limit check error', { error: error.message });
      return res.status(500).json({ error: 'Failed to check plan limits' });
    }
  };
};

// Middleware to check subscription status
export const requireActiveSubscription = (req, res, next) => {
  if (!req.user) {
    return res.status(401).json({ error: 'Authentication required' });
  }

  // Admins bypass subscription checks
  if (req.user.role === 'admin') {
    return next();
  }

  if (req.user.subscription_status !== 'active') {
    logger.warn('Inactive subscription', {
      userId: req.user.id,
      status: req.user.subscription_status
    });
    return res.status(403).json({
      error: 'Subscription required',
      status: req.user.subscription_status,
      message: 'Please activate your subscription to continue'
    });
  }

  // Check if subscription has expired
  if (req.user.subscription_expires_at) {
    const expiresAt = new Date(req.user.subscription_expires_at);
    if (expiresAt < new Date()) {
      return res.status(403).json({
        error: 'Subscription expired',
        expired_at: req.user.subscription_expires_at,
        message: 'Please renew your subscription'
      });
    }
  }

  next();
};

export default {
  hasPermission,
  requirePermission,
  requireAdmin,
  requireOwnership,
  checkPlanLimit,
  requireActiveSubscription
};
