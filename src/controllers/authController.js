import User from '../models/User.js';
import { generateToken } from '../middleware/auth.js';
import { isValidEmail } from '../utils/validation.js';
import logger from '../utils/logger.js';
import jwt from 'jsonwebtoken';
import FirebaseService from '../services/FirebaseService.js';
import db from '../models/database.js';
import PasswordReset from '../models/PasswordReset.js';
import EmailService from '../services/EmailService.js';
import PushoverService from '../services/PushoverService.js';
import bcrypt from 'bcryptjs';
import StripeSubscription from '../models/StripeSubscription.js';
import Plan from '../models/Plan.js';
import RecaptchaService from '../services/RecaptchaService.js';

// Login
export const login = async (req, res) => {
  try {
    const { email, password, recaptchaToken } = req.body;

    // Verify reCAPTCHA
    const recaptchaResult = await RecaptchaService.verify(recaptchaToken, 'LOGIN', 0.5);
    if (!recaptchaResult.success) {
      logger.warn('Login blocked by reCAPTCHA', { email, error: recaptchaResult.error });
      return res.status(403).json({ error: recaptchaResult.error || 'Security verification failed. Please try again.' });
    }

    if (!email || !password) {
      return res.status(400).json({ error: 'Email and password required' });
    }

    if (!isValidEmail(email)) {
      return res.status(400).json({ error: 'Invalid email format' });
    }

    const user = await User.findByEmail(email);

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
    await User.updateLastLogin(user.id, ipAddress);

    // Get full user with plan details
    const userWithPlan = await User.findById(user.id);

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
export const getCurrentUser = async (req, res) => {
  try {
    // Fetch full user data with plan details
    // users.plan_id is the ONLY source of truth for user's current plan
    const userWithPlan = await User.findById(req.user.id);

    if (!userWithPlan) {
      return res.status(404).json({ error: 'User not found' });
    }

    // NOTE: We do NOT auto-downgrade expired subscriptions here
    // Reasons:
    // 1. Admin might have manually set the plan (should not be overridden)
    // 2. User might have paid via different method (web Stripe vs mobile IAP)
    // 3. Grace periods or extensions might be in place
    // Let the cron job (check-expired-subscriptions.js) handle expiry downgrades
    // That way admins can control when downgrades happen

    res.json({
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
        auth_provider: userWithPlan.auth_provider,
        account_credit: parseFloat(userWithPlan.account_credit || 0)
      },
    });
  } catch (error) {
    logger.error('Get current user error', { error: error.message });
    res.status(500).json({ error: 'Failed to get user data' });
  }
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
    const user = await User.findByEmail(req.user.email);
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
      const existingUser = await User.findByEmail(email);
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

    const user = await User.findByEmail(req.user.email);

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
    const targetUser = await User.findById(targetUserId);
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

    // Extract user data from decoded token (no additional API call needed)
    // Handle missing email (common with Apple Sign In when user has only phone number)
    let firebaseEmail = decodedToken.email;
    const firebaseEmailVerified = decodedToken.email_verified || false;
    const firebaseName = decodedToken.name;
    const firebasePicture = decodedToken.picture;
    const firebaseProvider = provider || decodedToken.firebase?.sign_in_provider || 'unknown';

    // If no email provided (e.g., Apple Sign In with phone-only account), generate a placeholder
    // This allows users without email to still use the app
    if (!firebaseEmail) {
      firebaseEmail = `${firebaseUid}@noemail.rexstream.app`;
      logger.info('Social login: No email provided, using placeholder email', {
        firebaseUid,
        provider: firebaseProvider,
        placeholderEmail: firebaseEmail
      });
    }

    // Check if user exists in database by Firebase UID
    let user = await User.findByFirebaseUid(firebaseUid);

    if (!user) {
      // Check if user exists by email (to link existing account)
      const existingUser = await User.findByEmail(firebaseEmail);

      if (existingUser) {
        // Link existing account with Firebase UID
        user = await User.updateSocialAuth(existingUser.id, {
          firebase_uid: firebaseUid,
          auth_provider: firebaseProvider,
          profile_picture: firebasePicture,
          email_verified: firebaseEmailVerified
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

        // Generate name from email or use Firebase UID
        let userName = firebaseName;
        if (!userName && firebaseEmail) {
          userName = firebaseEmail.split('@')[0];
        }
        if (!userName) {
          userName = `user_${firebaseUid.substring(0, 8)}`;
        }

        user = await User.createSocialUser({
          email: firebaseEmail,
          name: userName,
          auth_provider: firebaseProvider,
          firebase_uid: firebaseUid,
          email_verified: firebaseEmailVerified,
          profile_picture: firebasePicture,
          plan_id: freePlan?.id || 1
        });

        logger.info('New user created via social login', {
          userId: user.id,
          email: user.email,
          provider: provider,
          firebaseUid
        });

        // Send welcome email and notifications (don't wait)
        // Skip sending emails to placeholder addresses (users without real email)
        const userWithPlan = await User.findById(user.id);
        const isPlaceholderEmail = user.email?.endsWith('@noemail.rexstream.app');

        if (!isPlaceholderEmail) {
          EmailService.sendRegistrationEmail(user.email, user.name).catch(err =>
            logger.error('Failed to send registration email', { error: err.message })
          );
        }
        EmailService.notifyAdminNewSignup(userWithPlan).catch(err =>
          logger.error('Failed to send admin email notification', { error: err.message })
        );
        PushoverService.notifyNewSignup(userWithPlan).catch(err =>
          logger.error('Failed to send Pushover notification', { error: err.message })
        );
      }
    } else {
      // Update last login
      const ipAddress = req.ip || req.connection.remoteAddress;
      await User.updateLastLogin(user.id, ipAddress);

      // Update profile picture if changed
      if (firebasePicture && firebasePicture !== user.profile_picture) {
        await User.updateSocialAuth(user.id, {
          profile_picture: firebasePicture
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
    const userWithPlan = await User.findById(user.id);

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

    // Convert Firebase/technical errors to user-friendly messages
    let userMessage = 'Login failed. Please try again.';

    if (error.message) {
      const msg = error.message.toLowerCase();

      // Firebase auth errors
      if (msg.includes('account-exists-with-different-credential') || msg.includes('email-already-in-use')) {
        userMessage = 'An account with this email already exists. Please sign in with your original method or use a different email.';
      } else if (msg.includes('invalid') || msg.includes('expired') || msg.includes('token')) {
        userMessage = 'Your login session has expired. Please try signing in again.';
      } else if (msg.includes('network') || msg.includes('connection')) {
        userMessage = 'Network error. Please check your connection and try again.';
      } else if (msg.includes('permission') || msg.includes('unauthorized')) {
        userMessage = 'Authorization error. Please contact support if this persists.';
      } else if (msg.includes('not configured')) {
        userMessage = error.message; // Keep original message for configuration errors
      }
    }

    res.status(500).json({ error: userMessage });
  }
};

// Forgot password - send reset email
export const forgotPassword = async (req, res) => {
  try {
    const { email } = req.body;

    if (!email || !isValidEmail(email)) {
      return res.status(400).json({ error: 'Valid email required' });
    }

    const user = await User.findByEmail(email);

    if (!user) {
      // Don't reveal if user exists or not
      return res.json({ message: 'If that email exists, a reset link has been sent' });
    }

    // Check if user is social login
    if (user.auth_provider && user.auth_provider !== 'local') {
      return res.status(400).json({
        error: `This account uses ${user.auth_provider} login. Please use ${user.auth_provider} to sign in.`,
        provider: user.auth_provider
      });
    }

    // Create reset token
    const resetToken = await PasswordReset.create(user.id, email);

    // Send email
    const emailResult = await EmailService.sendForgotPasswordEmail(email, resetToken);

    if (!emailResult.success) {
      logger.error('Failed to send forgot password email', { email, error: emailResult.message });
      return res.status(500).json({ error: 'Failed to send reset email. Please contact support.' });
    }

    logger.info('Password reset requested', { email });

    res.json({ message: 'If that email exists, a reset link has been sent' });
  } catch (error) {
    logger.error('Forgot password error', { error: error.message });
    res.status(500).json({ error: 'Failed to process request' });
  }
};

// Reset password with token
export const resetPassword = async (req, res) => {
  try {
    const { token, password } = req.body;

    if (!token || !password) {
      return res.status(400).json({ error: 'Token and new password required' });
    }

    if (password.length < 6) {
      return res.status(400).json({ error: 'Password must be at least 6 characters' });
    }

    // Find valid token
    const resetRecord = await PasswordReset.findValidToken(token);

    if (!resetRecord) {
      return res.status(400).json({ error: 'Invalid or expired reset token' });
    }

    // Get user
    const user = await User.findByEmail(resetRecord.email);

    if (!user) {
      return res.status(404).json({ error: 'User not found' });
    }

    // Check if user is social login
    if (user.auth_provider && user.auth_provider !== 'local') {
      return res.status(400).json({
        error: `This account uses ${user.auth_provider} login. Password cannot be reset.`,
        provider: user.auth_provider
      });
    }

    // Hash new password
    const passwordHash = await bcrypt.hash(password, 10);

    // Update password in database
    const stmt = db.prepare('UPDATE users SET password_hash = ? WHERE id = ?');
    stmt.run(passwordHash, user.id);

    // Mark token as used
    await PasswordReset.markAsUsed(token);

    logger.info('Password reset successful', { userId: user.id, email: user.email });

    res.json({ message: 'Password reset successful. You can now login with your new password.' });
  } catch (error) {
    logger.error('Reset password error', { error: error.message });
    res.status(500).json({ error: 'Failed to reset password' });
  }
};

// Register OneSignal player ID
export const registerDevice = async (req, res) => {
  try {
    const { playerId } = req.body;

    if (!playerId) {
      return res.status(400).json({ error: 'Player ID required' });
    }

    await User.setOneSignalPlayerId(req.user.id, playerId);
    logger.info('OneSignal player ID registered', { userId: req.user.id, playerId });

    res.json({ success: true, message: 'Device registered for notifications' });
  } catch (error) {
    logger.error('Register device error', { error: error.message });
    res.status(500).json({ error: 'Failed to register device' });
  }
};

// Unregister OneSignal player ID (called on logout)
export const unregisterDevice = async (req, res) => {
  try {
    await User.clearOneSignalPlayerId(req.user.id);
    logger.info('OneSignal player ID cleared', { userId: req.user.id });

    res.json({ success: true, message: 'Device unregistered from notifications' });
  } catch (error) {
    logger.error('Unregister device error', { error: error.message });
    res.status(500).json({ error: 'Failed to unregister device' });
  }
};
