import User from '../models/User.js';
import { generateToken } from '../middleware/auth.js';
import { isValidEmail } from '../utils/validation.js';
import logger from '../utils/logger.js';

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

    logger.info('User logged in', { userId: user.id, email: user.email });

    res.json({
      token,
      user: {
        id: user.id,
        email: user.email,
        name: user.name,
        role: user.role,
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
