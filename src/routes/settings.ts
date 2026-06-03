import { Router, Response } from 'express';
import prisma from '../prisma';
import { authenticateToken, requireAdmin, AuthenticatedRequest } from '../middleware/auth';

const router = Router();

// GET /api/settings - Fetch all settings
router.get('/', async (req, res) => {
  try {
    const settings = await prisma.setting.findMany();
    const dict: Record<string, string> = {};
    settings.forEach(s => {
      dict[s.key] = s.value;
    });
    
    // Set default baking days if not exists
    if (!dict['bakingDays']) {
      dict['bakingDays'] = JSON.stringify(['Tuesday', 'Saturday']);
    }
    
    return res.json({ settings: dict });
  } catch (error) {
    console.error('Error fetching settings:', error);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

// POST /api/settings - Update/upsert a setting (Admin only)
router.post('/', authenticateToken, requireAdmin, async (req: AuthenticatedRequest, res: Response) => {
  const { key, value } = req.body;
  if (!key || typeof value !== 'string') {
    return res.status(400).json({ error: 'Key and string value are required' });
  }

  try {
    const setting = await prisma.setting.upsert({
      where: { key },
      update: { value },
      create: { key, value },
    });
    return res.json({ message: `Setting ${key} saved successfully`, setting });
  } catch (error) {
    console.error('Error saving setting:', error);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

export default router;
