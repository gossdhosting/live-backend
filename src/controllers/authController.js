import User from '../models/User.js';
import { generateToken } from '../middleware/auth.js';
import { isValidEmail } from '../utils/validation.js';
import logger from '../utils/logger.js';
import jwt from 'jsonwebtoken';
import FirebaseService from '../services/FirebaseService.js';
import db from '../models/database.js';

// Login
export const login = async (req, res) => {
  try {
    const { email, password } = req.body;

    if (!email || !password) {
      return res.status(400).json({ error: 'Email and password required' });
    }

    if (!isValidEmail(email)) {
      return res.status(400).json({ error: 'Invalid email format' });
    }

    const user = User.findByEmail(email);

    if (!user) {
      return res.status(401).json({ error: 'Invalid credentials' });
    }

    const isValidPassword = await User.verifyPassword(
      password,
      user.password_hash
    );

    if (!isValidPassword) {
      return res.status(401).json({ error: 'Invalid credentials' });
    }

    const token = generateToken(user.id);

    // Update last login info
    const ipAddress = req.ip || req.connection.remoteAddress;
    User.updateLastLogin(user.id, ipAddress);

    // Get full user with plan details
    const userWithPlan = User.findById(user.id);

    logger.info('User logged in', { userId: user.id, email: user.email });

    res.json({
      token,
      user: {
        id: userWithPlan.id,
        email: userWithPlan.email,
        name: userWithPlan.name,
        role: userWithPlan.role,
        plan_name: userWithPlan.plan_name,
        plan_id: userWithPlan.plan_id,
        subscription_status: userWithPlan.subscription_status,
        max_concurrent_streams: userWithPlan.max_concurrent_streams,
        max_bitrate: userWithPlan.max_bitrate,
        max_stream_duration: userWithPlan.max_stream_duration,
        storage_limit_mb: userWithPlan.storage_limit_mb,
        custom_watermark: userWithPlan.custom_watermark
      },
    });
  } catch (error) {
    logger.error('Login error', { error: error.message });
    res.status(500).json({ error: 'Internal server error' });
  }
};

// Get current user
export const getCurrentUser = (req, res) => {
  res.json({
    user: {
      id: req.user.id,
      email: req.user.email,
      name: req.user.name,
      role: req.user.role,
    },
  });
};

// Update profile (email and name)
export const updateProfile = async (req, res) => {
  try {
    const { email, name, currentPassword } = req.body;

    if (!currentPassword) {
      return res.status(400).json({ error: 'Current password required' });
    }

    if (!email && !name) {
      return res.status(400).json({ error: 'Email or name required' });
    }

    // Verify current password
    const user = User.findByEmail(req.user.email);
    const isValidPassword = await User.verifyPassword(
      currentPassword,
      user.password_hash
    );

    if (!isValidPassword) {
      return res.status(401).json({ error: 'Current password is incorrect' });
    }

    // Validate email if provided
    if (email && !isValidEmail(email)) {
      return res.status(400).json({ error: 'Invalid email format' });
    }

    // Check if email is already taken by another user
    if (email && email !== req.user.email) {
      const existingUser = User.findByEmail(email);
      if (existingUser) {
        return res.status(400).json({ error: 'Email already in use' });
      }
    }

    // Update user
    const updateData = {};
    if (email) updateData.email = email;
    if (name) updateData.name = name;

    await User.update(req.user.id, updateData);

    logger.info('Profile updated', { userId: req.user.id, email, name });

    res.json({ message: 'Profile updated successfully' });
  } catch (error) {
    logger.error('Update profile error', { error: error.message });
    res.status(500).json({ error: 'Internal server error' });
  }
};

// Change password
export const changePassword = async (req, res) => {
  try {
    const { currentPassword, newPassword } = req.body;

    if (!currentPassword || !newPassword) {
      return res
        .status(400)
        .json({ error: 'Current and new password required' });
    }

    if (newPassword.length < 6) {
      return res
        .status(400)
        .json({ error: 'New password must be at least 6 characters' });
    }

    const user = User.findByEmail(req.user.email);

    const isValidPassword = await User.verifyPassword(
      currentPassword,
      user.password_hash
    );

    if (!isValidPassword) {
      return res.status(401).json({ error: 'Current password is incorrect' });
    }

    await User.update(req.user.id, { password: newPassword });

    logger.info('Password changed', { userId: req.user.id });

    res.json({ message: 'Password changed successfully' });
  } catch (error) {
    logger.error('Change password error', { error: error.message });
    res.status(500).json({ error: 'Internal server error' });
  }
};

// Admin login as user
export const adminLoginAsUser = async (req, res) => {
  try {
    const { userId } = req.params;
    const targetUserId = parseInt(userId);

    // Verify target user exists
    const targetUser = User.findById(targetUserId);
    if (!targetUser) {
      return res.status(404).json({ error: 'User not found' });
    }

    // Prevent admin from logging into another admin account
    if (targetUser.role === 'admin') {
      return res.status(403).json({ error: 'Cannot login as another admin' });
    }

    // Generate JWT for target user
    const token = jwt.sign(
      {
        userId: targetUser.id,
        email: targetUser.email,
        role: targetUser.role,
        plan_id: targetUser.plan_id,
        isAdminSession: true, // Flag to indicate this is an admin session
        adminId: req.user.id // Store the admin's ID
      },
      process.env.JWT_SECRET,
      { expiresIn: '24h' }
    );

    logger.info('Admin logged in as user', {
      adminId: req.user.id,
      adminEmail: req.user.email,
      targetUserId: targetUser.id,
      targetUserEmail: targetUser.email
    });

    res.json({
      token,
      user: {
        id: targetUser.id,
        email: targetUser.email,
        name: targetUser.name,
        role: targetUser.role,
        plan_id: targetUser.plan_id,
        isAdminSession: true
      }
    });
  } catch (error) {
    logger.error('Admin login as user error', { error: error.message });
    res.status(500).json({ error: 'Internal server error' });
  }
};

// Social login with Firebase
export const socialLogin = async (req, res) => {
  try {
    const { idToken, provider } = req.body;

    if (!idToken) {
      return res.status(400).json({ error: 'Firebase ID token required' });
    }

    // Check if Firebase is configured
    if (!FirebaseService.isAvailable()) {
      return res.status(503).json({
        error: 'Social login is not configured. Please use email/password login.'
      });
    }

    // Verify Firebase token
    const decodedToken = await FirebaseService.verifyIdToken(idToken);
    const firebaseUid = decodedToken.uid;

    // Get Firebase user details
    const firebaseUser = await FirebaseService.getFirebaseUser(firebaseUid);

    // Check if user exists in database by Firebase UID
    let user = User.findByFirebaseUid(firebaseUid);

    if (!user) {
      // Check if user exists by email (to link existing account)
      const existingUser = User.findByEmail(firebaseUser.email);

      if (existingUser) {
        // Link existing account with Firebase UID
        user = User.updateSocialAuth(existingUser.id, {
          firebase_uid: firebaseUid,
          auth_provider: provider || decodedToken.firebase.sign_in_provider,
          profile_picture: firebaseUser.photoURL,
          email_verified: firebaseUser.emailVerified
        });

        logger.info('Linked existing user with social account', {
          userId: user.id,
          email: user.email,
          provider: provider,
          firebaseUid
        });
      } else {
        // Create new user from Firebase data
        const freePlan = db.prepare("SELECT id FROM plans WHERE name = 'Free' LIMIT 1").get();

        user = await User.createSocialUser({
          email: firebaseUser.email,
          name: firebaseUser.displayName || firebaseUser.email.split('@')[0],
          auth_provider: provider || decodedToken.firebase.sign_in_provider,
          firebase_uid: firebaseUid,
          email_verified: firebaseUser.emailVerified,
          profile_picture: firebaseUser.photoURL,
          plan_id: freePlan?.id || 1
        });

        logger.info('New user created via social login', {
          userId: user.id,
          email: user.email,
          provider: provider,
          firebaseUid
        });
      }
    } else {
      // Update last login
      const ipAddress = req.ip || req.connection.remoteAddress;
      User.updateLastLogin(user.id, ipAddress);

      // Update profile picture if changed
      if (firebaseUser.photoURL && firebaseUser.photoURL !== user.profile_picture) {
        User.updateSocialAuth(user.id, {
          profile_picture: firebaseUser.photoURL
        });
      }

      logger.info('User logged in via social auth', {
        userId: user.id,
        email: user.email,
        provider: user.auth_provider
      });
    }

    // Generate JWT token
    const token = generateToken(user.id);

    // Get full user with plan details
    const userWithPlan = User.findById(user.id);

    res.json({
      token,
      user: {
        id: userWithPlan.id,
        email: userWithPlan.email,
        name: userWithPlan.name,
        role: userWithPlan.role,
        plan_name: userWithPlan.plan_name,
        plan_id: userWithPlan.plan_id,
        subscription_status: userWithPlan.subscription_status,
        max_concurrent_streams: userWithPlan.max_concurrent_streams,
        max_bitrate: userWithPlan.max_bitrate,
        max_stream_duration: userWithPlan.max_stream_duration,
        storage_limit_mb: userWithPlan.storage_limit_mb,
        custom_watermark: userWithPlan.custom_watermark,
        profile_picture: userWithPlan.profile_picture,
        auth_provider: userWithPlan.auth_provider
      },
    });
  } catch (error) {
    logger.error('Social login error', { error: error.message, stack: error.stack });
    res.status(500).json({ error: error.message || 'Social login failed' });
  }
};
