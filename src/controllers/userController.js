import User from '../models/User.js';
import Plan from '../models/Plan.js';
import logger from '../utils/logger.js';
import { isValidEmail } from '../utils/validation.js';

// Register new user (public endpoint)
export const register = async (req, res) => {
  try {
    const { email, password, name, plan_id, subscription_type } = req.body;

    // Validation
    if (!email || !password || !name) {
      return res.status(400).json({ error: 'Email, password, and name are required' });
    }

    if (!isValidEmail(email)) {
      return res.status(400).json({ error: 'Invalid email format' });
    }

    if (password.length < 6) {
      return res.status(400).json({ error: 'Password must be at least 6 characters' });
    }

    // Check if email already exists
    const existingUser = User.findByEmail(email);
    if (existingUser) {
      return res.status(400).json({ error: 'Email already registered' });
    }

    // Validate plan
    let selectedPlanId = plan_id;
    if (!selectedPlanId) {
      // Default to Free plan
      const freePlan = Plan.getByName('Free');
      selectedPlanId = freePlan?.id;
    } else {
      const plan = Plan.getById(selectedPlanId);
      if (!plan) {
        return res.status(400).json({ error: 'Invalid plan selected' });
      }
    }

    // Create user
    const user = await User.create({
      email,
      password,
      name,
      role: 'user',
      plan_id: selectedPlanId,
      subscription_type: subscription_type || 'monthly'
    });

    logger.info('User registered', { userId: user.id, email: user.email });

    res.status(201).json({
      message: 'Registration successful',
      user: {
        id: user.id,
        email: user.email,
        name: user.name,
        role: user.role,
        plan_name: user.plan_name
      }
    });
  } catch (error) {
    logger.error('Registration error', { error: error.message });
    res.status(500).json({ error: 'Registration failed' });
  }
};

// Get all users (admin only)
export const getAllUsers = async (req, res) => {
  try {
    const { includeInactive } = req.query;
    const users = User.getAll({ includeInactive: includeInactive === 'true' });

    res.json({ users });
  } catch (error) {
    logger.error('Failed to fetch users', { error: error.message });
    res.status(500).json({ error: 'Failed to fetch users' });
  }
};

// Get user by ID (admin or self)
export const getUserById = async (req, res) => {
  try {
    const { id } = req.params;
    const userId = parseInt(id);

    // Users can only view their own profile, admins can view all
    if (req.user.role !== 'admin' && req.user.id !== userId) {
      return res.status(403).json({ error: 'Access denied' });
    }

    const user = User.getUserWithPlan(userId);

    if (!user) {
      return res.status(404).json({ error: 'User not found' });
    }

    res.json({ user });
  } catch (error) {
    logger.error('Failed to fetch user', { error: error.message });
    res.status(500).json({ error: 'Failed to fetch user' });
  }
};

// Update user (admin or self)
export const updateUser = async (req, res) => {
  try {
    const { id } = req.params;
    const userId = parseInt(id);
    const { email, name, role, plan_id, subscription_type, subscription_status, status } = req.body;

    // Users can only update their own profile (limited fields)
    if (req.user.role !== 'admin' && req.user.id !== userId) {
      return res.status(403).json({ error: 'Access denied' });
    }

    // Check if user exists
    const existingUser = User.findById(userId);
    if (!existingUser) {
      return res.status(404).json({ error: 'User not found' });
    }

    // Build update data
    const updateData = {};

    // Users can update their own email and name
    if (email !== undefined) {
      if (!isValidEmail(email)) {
        return res.status(400).json({ error: 'Invalid email format' });
      }
      // Check if email is taken by another user
      if (email !== existingUser.email) {
        const emailTaken = User.findByEmail(email);
        if (emailTaken) {
          return res.status(400).json({ error: 'Email already in use' });
        }
      }
      updateData.email = email;
    }

    if (name !== undefined) {
      updateData.name = name;
    }

    // Only admins can update role, plan, subscription, and status
    if (req.user.role === 'admin') {
      if (role !== undefined) {
        if (!['admin', 'user'].includes(role)) {
          return res.status(400).json({ error: 'Invalid role' });
        }
        updateData.role = role;
      }

      if (plan_id !== undefined) {
        const plan = Plan.getById(plan_id);
        if (!plan) {
          return res.status(400).json({ error: 'Invalid plan' });
        }
        updateData.plan_id = plan_id;
      }

      if (subscription_type !== undefined) {
        if (!['monthly', 'yearly'].includes(subscription_type)) {
          return res.status(400).json({ error: 'Invalid subscription type' });
        }
        updateData.subscription_type = subscription_type;
      }

      if (subscription_status !== undefined) {
        if (!['active', 'cancelled', 'expired'].includes(subscription_status)) {
          return res.status(400).json({ error: 'Invalid subscription status' });
        }
        updateData.subscription_status = subscription_status;
      }

      if (status !== undefined) {
        if (!['active', 'suspended'].includes(status)) {
          return res.status(400).json({ error: 'Invalid status' });
        }
        updateData.status = status;
      }
    }

    const updatedUser = await User.update(userId, updateData);

    logger.info('User updated', { userId, updatedBy: req.user.id });

    res.json({
      message: 'User updated successfully',
      user: updatedUser
    });
  } catch (error) {
    logger.error('Failed to update user', { error: error.message });
    res.status(500).json({ error: 'Failed to update user' });
  }
};

// Delete user (admin only)
export const deleteUser = async (req, res) => {
  try {
    const { id } = req.params;
    const userId = parseInt(id);

    // Check if user exists
    const user = User.findById(userId);
    if (!user) {
      return res.status(404).json({ error: 'User not found' });
    }

    // Prevent self-deletion
    if (req.user.id === userId) {
      return res.status(400).json({ error: 'Cannot delete your own account' });
    }

    User.delete(userId);

    logger.info('User deleted', { userId, deletedBy: req.user.id });

    res.json({ message: 'User deleted successfully' });
  } catch (error) {
    logger.error('Failed to delete user', { error: error.message });
    res.status(500).json({ error: 'Failed to delete user' });
  }
};

// Get user statistics and limits
export const getUserStats = async (req, res) => {
  try {
    const userId = req.user.role === 'admin' && req.params.id
      ? parseInt(req.params.id)
      : req.user.id;

    const stats = User.getUserStats(userId);
    const planLimits = await User.checkPlanLimits(userId);

    // Flatten the structure for easier frontend access
    res.json({
      ...stats,
      limits: planLimits.limits,
      usage: planLimits.usage,
      canCreate: planLimits.canCreate,
      plan: { name: planLimits.user_plan }
    });
  } catch (error) {
    logger.error('Failed to fetch user stats', { error: error.message });
    res.status(500).json({ error: 'Failed to fetch statistics' });
  }
};
