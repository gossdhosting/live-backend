import Plan from '../models/Plan.js';
import logger from '../utils/logger.js';

// Get all active plans (public endpoint - excludes hidden plans)
export const getAllPlans = async (req, res) => {
  try {
    // Only show non-hidden plans to regular users
    const plans = await Plan.getAll();
    res.json({ plans });
  } catch (error) {
    logger.error('Failed to fetch plans', { error: error.message });
    res.status(500).json({ error: 'Failed to fetch plans' });
  }
};

// Get all plans for admin (includes hidden plans)
export const getAllPlansForAdmin = async (req, res) => {
  try {
    // Use getAllWithStats to include subscriber counts (includes hidden plans)
    const plans = await Plan.getAllWithStats();
    res.json({ plans });
  } catch (error) {
    logger.error('Failed to fetch plans for admin', { error: error.message });
    res.status(500).json({ error: 'Failed to fetch plans' });
  }
};

// Get plan by ID
export const getPlanById = async (req, res) => {
  try {
    const { id } = req.params;
    const plan = await Plan.getById(id);

    if (!plan) {
      return res.status(404).json({ error: 'Plan not found' });
    }

    res.json({ plan });
  } catch (error) {
    logger.error('Failed to fetch plan', { error: error.message });
    res.status(500).json({ error: 'Failed to fetch plan' });
  }
};

// Get plan statistics (admin only)
export const getPlanStats = async (req, res) => {
  try {
    const statsArray = await Plan.getPlanStats();
    // Convert array to object keyed by plan ID for easier frontend access
    const stats = {};
    statsArray.forEach(stat => {
      stats[stat.id] = {
        subscriber_count: stat.subscriber_count,
        active_subscribers: stat.active_subscribers
      };
    });
    res.json({ stats });
  } catch (error) {
    logger.error('Failed to fetch plan stats', { error: error.message });
    res.status(500).json({ error: 'Failed to fetch statistics' });
  }
};

// Create new plan (admin only)
export const createPlan = async (req, res) => {
  try {
    const {
      name,
      description,
      price_monthly,
      price_yearly,
      stripe_price_id_monthly,
      stripe_price_id_yearly,
      stripe_product_id,
      max_concurrent_streams,
      max_bitrate,
      max_stream_duration,
      storage_limit_mb,
      custom_watermark,
      max_platform_connections,
      youtube_restreaming,
      schedule_enabled,
      cloud_storage_enabled,
      hls_embed_enabled,
      android_product_id_monthly,
      android_product_id_yearly,
      ios_product_id_monthly,
      ios_product_id_yearly
    } = req.body;

    // Validation
    if (!name || price_monthly === undefined || price_yearly === undefined) {
      return res.status(400).json({ error: 'Name and prices are required' });
    }

    if (max_concurrent_streams === undefined || max_bitrate === undefined || storage_limit_mb === undefined) {
      return res.status(400).json({ error: 'Limits are required' });
    }

    // Check if plan name already exists
    const existingPlan = await Plan.getByName(name);
    if (existingPlan) {
      return res.status(400).json({ error: 'Plan name already exists' });
    }

    const plan = await Plan.create({
      name,
      description,
      price_monthly,
      price_yearly,
      stripe_price_id_monthly: stripe_price_id_monthly || null,
      stripe_price_id_yearly: stripe_price_id_yearly || null,
      stripe_product_id: stripe_product_id || null,
      max_concurrent_streams,
      max_bitrate,
      max_stream_duration: max_stream_duration || null,
      storage_limit_mb,
      custom_watermark: custom_watermark || false,
      max_platform_connections: max_platform_connections || 1,
      youtube_restreaming: youtube_restreaming || false,
      schedule_enabled: schedule_enabled || false,
      cloud_storage_enabled: cloud_storage_enabled || false,
      hls_embed_enabled: hls_embed_enabled || false,
      android_product_id_monthly: android_product_id_monthly || null,
      android_product_id_yearly: android_product_id_yearly || null,
      ios_product_id_monthly: ios_product_id_monthly || null,
      ios_product_id_yearly: ios_product_id_yearly || null
    });

    logger.info('Plan created', { planId: plan.id, name: plan.name, createdBy: req.user.id });

    res.status(201).json({
      message: 'Plan created successfully',
      plan
    });
  } catch (error) {
    logger.error('Failed to create plan', { error: error.message });
    res.status(500).json({ error: 'Failed to create plan' });
  }
};

// Update plan (admin only)
export const updatePlan = async (req, res) => {
  try {
    const { id } = req.params;
    const {
      name,
      description,
      price_monthly,
      price_yearly,
      stripe_price_id_monthly,
      stripe_price_id_yearly,
      stripe_product_id,
      max_concurrent_streams,
      max_bitrate,
      max_stream_duration,
      storage_limit_mb,
      custom_watermark,
      max_platform_connections,
      is_active,
      is_hidden,
      youtube_restreaming,
      schedule_enabled,
      cloud_storage_enabled,
      hls_embed_enabled,
      android_product_id_monthly,
      android_product_id_yearly,
      ios_product_id_monthly,
      ios_product_id_yearly
    } = req.body;

    logger.info('Update plan called', { planId: id, updateFields: Object.keys(req.body) });
    console.log('[Plan] Update request for plan', id, ':', JSON.stringify(req.body, null, 2));

    // Check if plan exists
    const existingPlan = await Plan.getById(id);
    if (!existingPlan) {
      logger.warn('Plan not found', { planId: id });
      return res.status(404).json({ error: 'Plan not found' });
    }

    logger.info('Existing plan found', { planId: id, currentName: existingPlan.name });

    // Check if new name conflicts with existing plan
    if (name && name !== existingPlan.name) {
      const nameTaken = await Plan.getByName(name);
      if (nameTaken) {
        logger.warn('Plan name already taken', { planId: id, name });
        return res.status(400).json({ error: 'Plan name already exists' });
      }
    }

    const updateData = {};
    if (name !== undefined) updateData.name = name;
    if (description !== undefined) updateData.description = description;
    if (price_monthly !== undefined) updateData.price_monthly = price_monthly;
    if (price_yearly !== undefined) updateData.price_yearly = price_yearly;
    if (stripe_price_id_monthly !== undefined) updateData.stripe_price_id_monthly = stripe_price_id_monthly;
    if (stripe_price_id_yearly !== undefined) updateData.stripe_price_id_yearly = stripe_price_id_yearly;
    if (stripe_product_id !== undefined) updateData.stripe_product_id = stripe_product_id;
    if (max_concurrent_streams !== undefined) updateData.max_concurrent_streams = max_concurrent_streams;
    if (max_bitrate !== undefined) updateData.max_bitrate = max_bitrate;
    if (max_stream_duration !== undefined) updateData.max_stream_duration = max_stream_duration;
    if (storage_limit_mb !== undefined) updateData.storage_limit_mb = storage_limit_mb;
    if (custom_watermark !== undefined) updateData.custom_watermark = custom_watermark;
    if (max_platform_connections !== undefined) updateData.max_platform_connections = max_platform_connections;
    if (is_active !== undefined) updateData.is_active = is_active;
    if (is_hidden !== undefined) updateData.is_hidden = is_hidden;
    if (youtube_restreaming !== undefined) updateData.youtube_restreaming = youtube_restreaming;
    if (schedule_enabled !== undefined) updateData.schedule_enabled = schedule_enabled;
    if (cloud_storage_enabled !== undefined) updateData.cloud_storage_enabled = cloud_storage_enabled;
    if (hls_embed_enabled !== undefined) updateData.hls_embed_enabled = hls_embed_enabled;
    if (android_product_id_monthly !== undefined) updateData.android_product_id_monthly = android_product_id_monthly;
    if (android_product_id_yearly !== undefined) updateData.android_product_id_yearly = android_product_id_yearly;
    if (ios_product_id_monthly !== undefined) updateData.ios_product_id_monthly = ios_product_id_monthly;
    if (ios_product_id_yearly !== undefined) updateData.ios_product_id_yearly = ios_product_id_yearly;

    logger.info('Calling Plan.update with data', { planId: id, updateDataKeys: Object.keys(updateData) });
    console.log('[Plan] Update data:', JSON.stringify(updateData, null, 2));

    const plan = await Plan.update(id, updateData);

    logger.info('Plan updated successfully', { planId: id, updatedBy: req.user.id, returnedPlan: !!plan });
    console.log('[Plan] Updated plan:', JSON.stringify(plan, null, 2));

    res.json({
      message: 'Plan updated successfully',
      plan
    });
  } catch (error) {
    logger.error('Failed to update plan', { error: error.message, stack: error.stack });
    console.error('[Plan] Update failed:', error);
    res.status(500).json({ error: 'Failed to update plan' });
  }
};

// Delete plan (admin only)
export const deletePlan = async (req, res) => {
  try {
    const { id } = req.params;

    // Check if plan exists
    const plan = await Plan.getById(id);
    if (!plan) {
      return res.status(404).json({ error: 'Plan not found' });
    }

    // Attempt to delete (soft delete)
    try {
      await Plan.delete(id);
      logger.info('Plan deleted', { planId: id, deletedBy: req.user.id });
      res.json({ message: 'Plan deactivated successfully' });
    } catch (error) {
      // If error is due to users on this plan
      if (error.message.includes('Cannot delete plan')) {
        return res.status(400).json({ error: error.message });
      }
      throw error;
    }
  } catch (error) {
    logger.error('Failed to delete plan', { error: error.message });
    res.status(500).json({ error: 'Failed to delete plan' });
  }
};
