import { Router, Response } from 'express';
import prisma from '../prisma';
import { authenticateToken, requireAdmin, requireApproved, AuthenticatedRequest } from '../middleware/auth';

const router = Router();

// Helper to normalize any date to the starting Monday of that week
const getMondayOfDate = (dateStr?: string) => {
  const date = dateStr ? new Date(dateStr) : new Date();
  const day = date.getDay();
  const diff = date.getDate() - day + (day === 0 ? -6 : 1); // adjust when day is sunday
  const monday = new Date(date.setDate(diff));
  monday.setHours(0, 0, 0, 0);
  return monday;
};

// 1. Get the current active menu for the upcoming week (Approved customers & Admins)
router.get('/current', authenticateToken, requireApproved, async (req: AuthenticatedRequest, res: Response) => {
  const { date } = req.query; // optional custom target week date
  const targetMonday = getMondayOfDate(date as string);

  try {
    const menu = await prisma.weeklyMenu.findUnique({
      where: { weekStartDate: targetMonday },
      include: {
        products: {
          include: {
            product: {
              include: {
                variants: {
                  include: {
                    recipe: true,
                  },
                },
              },
            },
          },
        },
      },
    });

    if (!menu) {
      return res.json({
        weekStartDate: targetMonday,
        products: [],
        message: 'No weekly menu has been published yet for this week.',
      });
    }

    // Filter only active products
    const activeProducts = menu.products
      .filter((p) => p.product.active)
      .map((p) => p.product);

    return res.json({
      id: menu.id,
      weekStartDate: menu.weekStartDate,
      products: activeProducts,
    });
  } catch (error) {
    console.error('Error fetching current menu:', error);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

// 2. Get all published weekly menus (Admin only)
router.get('/', authenticateToken, requireAdmin, async (req: AuthenticatedRequest, res: Response) => {
  try {
    const menus = await prisma.weeklyMenu.findMany({
      include: {
        products: {
          include: {
            product: true,
          },
        },
      },
      orderBy: { weekStartDate: 'desc' },
    });
    return res.json({ menus });
  } catch (error) {
    console.error('Error fetching weekly menus:', error);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

// 3. Create or update a weekly menu (Admin only)
// Body: { weekStartDate: "2026-05-28", productIds: ["uuid1", "uuid2"] }
router.post('/', authenticateToken, requireAdmin, async (req: AuthenticatedRequest, res: Response) => {
  const { weekStartDate, productIds } = req.body;

  if (!weekStartDate || !Array.isArray(productIds)) {
    return res.status(400).json({ error: 'Week start date and productIds list are required' });
  }

  const targetMonday = getMondayOfDate(weekStartDate);

  try {
    // 1. Upsert the WeeklyMenu container
    const menu = await prisma.weeklyMenu.upsert({
      where: { weekStartDate: targetMonday },
      update: {},
      create: { weekStartDate: targetMonday },
    });

    // 2. Clear out existing menu products for this week
    await prisma.weeklyMenuProduct.deleteMany({
      where: { weeklyMenuId: menu.id },
    });

    // 3. Insert newly assigned products
    if (productIds.length > 0) {
      await prisma.weeklyMenuProduct.createMany({
        data: productIds.map((pId: string) => ({
          weeklyMenuId: menu.id,
          productId: pId,
        })),
        skipDuplicates: true,
      });
    }

    const updatedMenu = await prisma.weeklyMenu.findUnique({
      where: { id: menu.id },
      include: {
        products: {
          include: {
            product: {
              include: {
                variants: true,
              },
            },
          },
        },
      },
    });

    return res.json({
      message: 'Weekly menu successfully updated',
      menu: {
        id: updatedMenu?.id,
        weekStartDate: updatedMenu?.weekStartDate,
        products: updatedMenu?.products.map((p) => p.product) || [],
      },
    });
  } catch (error) {
    console.error('Error updating weekly menu:', error);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

export default router;
