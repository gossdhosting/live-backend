import express from 'express';
import { authenticateToken } from '../middleware/auth.js';
import { requireAdmin } from '../middleware/permissions.js';
import FAQ from '../models/FAQ.js';
import logger from '../utils/logger.js';

const router = express.Router();

// Get all active FAQs (public/authenticated users)
router.get('/', async (req, res) => {
  try {
    const faqs = await FAQ.getActive();
    res.json({ faqs });
  } catch (error) {
    logger.error('Failed to fetch FAQs', { error: error.message });
    res.status(500).json({ error: 'Failed to fetch FAQs' });
  }
});

// Get all FAQs including inactive (admin only)
router.get('/all', authenticateToken, requireAdmin, async (req, res) => {
  try {
    const faqs = await FAQ.getAll();
    res.json({ faqs });
  } catch (error) {
    logger.error('Failed to fetch all FAQs', { error: error.message });
    res.status(500).json({ error: 'Failed to fetch FAQs' });
  }
});

// Get FAQ by ID
router.get('/:id', async (req, res) => {
  try {
    const faq = await FAQ.getById(req.params.id);
    if (!faq) {
      return res.status(404).json({ error: 'FAQ not found' });
    }
    res.json({ faq });
  } catch (error) {
    logger.error('Failed to fetch FAQ', { error: error.message });
    res.status(500).json({ error: 'Failed to fetch FAQ' });
  }
});

// Create FAQ (admin only)
router.post('/', authenticateToken, requireAdmin, async (req, res) => {
  try {
    const { question, answer, category, display_order, is_active } = req.body;

    if (!question || !answer) {
      return res.status(400).json({ error: 'Question and answer are required' });
    }

    const faq = await FAQ.create({
      question,
      answer,
      category,
      display_order: display_order || 0,
      is_active: is_active !== undefined ? is_active : true,
    });

    logger.info('FAQ created', { faqId: faq.id, userId: req.user.id });
    res.status(201).json({ faq });
  } catch (error) {
    logger.error('Failed to create FAQ', { error: error.message });
    res.status(500).json({ error: 'Failed to create FAQ' });
  }
});

// Update FAQ (admin only)
router.put('/:id', authenticateToken, requireAdmin, async (req, res) => {
  try {
    const { question, answer, category, display_order, is_active } = req.body;

    if (!question || !answer) {
      return res.status(400).json({ error: 'Question and answer are required' });
    }

    const faq = await FAQ.update(req.params.id, {
      question,
      answer,
      category,
      display_order: display_order || 0,
      is_active: is_active !== undefined ? is_active : true,
    });

    if (!faq) {
      return res.status(404).json({ error: 'FAQ not found' });
    }

    logger.info('FAQ updated', { faqId: req.params.id, userId: req.user.id });
    res.json({ faq });
  } catch (error) {
    logger.error('Failed to update FAQ', { error: error.message });
    res.status(500).json({ error: 'Failed to update FAQ' });
  }
});

// Delete FAQ (admin only)
router.delete('/:id', authenticateToken, requireAdmin, async (req, res) => {
  try {
    await FAQ.delete(req.params.id);
    logger.info('FAQ deleted', { faqId: req.params.id, userId: req.user.id });
    res.json({ message: 'FAQ deleted successfully' });
  } catch (error) {
    logger.error('Failed to delete FAQ', { error: error.message });
    res.status(500).json({ error: 'Failed to delete FAQ' });
  }
});

// Reorder FAQs (admin only)
router.post('/reorder', authenticateToken, requireAdmin, async (req, res) => {
  try {
    const { faqOrders } = req.body;

    if (!Array.isArray(faqOrders)) {
      return res.status(400).json({ error: 'faqOrders must be an array' });
    }

    await FAQ.updateOrder(faqOrders);
    logger.info('FAQs reordered', { userId: req.user.id });
    res.json({ message: 'FAQs reordered successfully' });
  } catch (error) {
    logger.error('Failed to reorder FAQs', { error: error.message });
    res.status(500).json({ error: 'Failed to reorder FAQs' });
  }
});

export default router;
