import { Router, Response } from 'express';
import prisma from '../prisma';
import { authenticateToken, requireApproved, requireAdmin, AuthenticatedRequest } from '../middleware/auth';
import { findOrCreateBatchForSlot } from './orders';

const router = Router();

// Helper to normalize any date to the starting Monday of that week
const getMondayOfDate = (date: Date = new Date()) => {
  const day = date.getDay();
  const diff = date.getDate() - day + (day === 0 ? -6 : 1);
  const monday = new Date(date.setDate(diff));
  monday.setHours(0, 0, 0, 0);
  return monday;
};

// 1. Get standing orders (Admin sees all, Customer sees only their own)
router.get('/', authenticateToken, requireApproved, async (req: AuthenticatedRequest, res: Response) => {
  if (!req.user) return res.status(401).json({ error: 'Unauthorized' });

  try {
    let standingOrders;
    if (req.user.role === 'ADMIN') {
      standingOrders = await prisma.standingOrder.findMany({
        include: {
          user: { select: { id: true, name: true, email: true, phone: true } },
          productVariant: {
            include: { product: true },
          },
        },
        orderBy: { createdAt: 'desc' },
      });
    } else {
      standingOrders = await prisma.standingOrder.findMany({
        where: { userId: req.user.id },
        include: {
          productVariant: {
            include: { product: true },
          },
        },
        orderBy: { createdAt: 'desc' },
      });
    }

    return res.json({ standingOrders });
  } catch (error) {
    console.error('Error fetching standing orders:', error);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

// 2. Subscribe to / Create a standing order (Approved Customers and Admins)
router.post('/', authenticateToken, requireApproved, async (req: AuthenticatedRequest, res: Response) => {
  if (!req.user) return res.status(401).json({ error: 'Unauthorized' });
  const { productVariantId, quantity, pickupSlot } = req.body;

  if (!productVariantId || !pickupSlot || typeof quantity !== 'number' || quantity <= 0) {
    return res.status(400).json({ error: 'productVariantId, quantity, and pickupSlot are required' });
  }

  try {
    // Check if variant exists
    const variant = await prisma.productVariant.findUnique({
      where: { id: productVariantId },
    });

    if (!variant) {
      return res.status(404).json({ error: 'Product variant not found' });
    }

    // Check if standing order already exists for this variant/user
    const existing = await prisma.standingOrder.findFirst({
      where: {
        userId: req.user.id,
        productVariantId,
      },
    });

    if (existing) {
      // Update quantity and slot of existing subscription
      const updated = await prisma.standingOrder.update({
        where: { id: existing.id },
        data: {
          quantity,
          pickupSlot,
          active: true,
        },
        include: {
          productVariant: { include: { product: true } },
        },
      });
      return res.json({ message: 'Standing order updated successfully', standingOrder: updated });
    }

    // Create a new standing order
    const newStandingOrder = await prisma.standingOrder.create({
      data: {
        userId: req.user.id,
        productVariantId,
        quantity,
        pickupSlot,
        active: true,
      },
      include: {
        productVariant: { include: { product: true } },
      },
    });

    return res.status(201).json({
      message: 'Subscribed to standing order successfully',
      standingOrder: newStandingOrder,
    });
  } catch (error) {
    console.error('Error creating standing order:', error);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

// 3. Update subscription status or parameters
router.put('/:id', authenticateToken, requireApproved, async (req: AuthenticatedRequest, res: Response) => {
  if (!req.user) return res.status(401).json({ error: 'Unauthorized' });
  const { id } = req.params;
  const { quantity, pickupSlot, active } = req.body;

  try {
    const sub = await prisma.standingOrder.findUnique({ where: { id } });
    if (!sub) return res.status(404).json({ error: 'Standing order not found' });

    // Validate ownership
    if (req.user.role !== 'ADMIN' && sub.userId !== req.user.id) {
      return res.status(403).json({ error: 'Forbidden' });
    }

    const updated = await prisma.standingOrder.update({
      where: { id },
      data: {
        quantity: typeof quantity === 'number' && quantity > 0 ? quantity : undefined,
        pickupSlot: pickupSlot || undefined,
        active: typeof active === 'boolean' ? active : undefined,
      },
      include: {
        productVariant: { include: { product: true } },
      },
    });

    return res.json({ message: 'Standing order updated successfully', standingOrder: updated });
  } catch (error) {
    console.error('Error updating standing order:', error);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

// 4. Cancel/Delete standing order
router.delete('/:id', authenticateToken, requireApproved, async (req: AuthenticatedRequest, res: Response) => {
  if (!req.user) return res.status(401).json({ error: 'Unauthorized' });
  const { id } = req.params;

  try {
    const sub = await prisma.standingOrder.findUnique({ where: { id } });
    if (!sub) return res.status(404).json({ error: 'Standing order not found' });

    // Validate ownership
    if (req.user.role !== 'ADMIN' && sub.userId !== req.user.id) {
      return res.status(403).json({ error: 'Forbidden' });
    }

    await prisma.standingOrder.delete({ where: { id } });
    return res.json({ message: 'Standing order subscription cancelled successfully' });
  } catch (error) {
    console.error('Error deleting standing order:', error);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

export async function runSubscriptionOrderGeneration(): Promise<number> {
  const targetMonday = getMondayOfDate(new Date());

  // Fetch this week's active menu
  const menu = await prisma.weeklyMenu.findUnique({
    where: { weekStartDate: targetMonday },
    include: {
      products: {
        select: { productId: true },
      },
    },
  });

  if (!menu || menu.products.length === 0) {
    console.log('Subscription generator: No menu has been published for this week.');
    return 0;
  }

  const activeProductIds = menu.products.map((p) => p.productId);

  // Fetch all active standing orders
  const activeSubs = await prisma.standingOrder.findMany({
    where: { active: true },
    include: {
      productVariant: true,
    },
  });

  // Filter standing orders where their product is currently on the weekly menu
  const eligibleSubs = activeSubs.filter((sub) =>
    activeProductIds.includes(sub.productVariant.productId)
  );

  if (eligibleSubs.length === 0) {
    console.log('Subscription generator: No active standing orders matched the current weekly menu products.');
    return 0;
  }

  // Group subscriptions by userId
  const subsByUser: Record<string, typeof eligibleSubs> = {};
  eligibleSubs.forEach((sub) => {
    if (!subsByUser[sub.userId]) {
      subsByUser[sub.userId] = [];
    }
    subsByUser[sub.userId].push(sub);
  });

  let generatedCount = 0;

  // For each user, create a single PENDING order containing their subscribed items
  for (const [userId, userSubs] of Object.entries(subsByUser)) {
    // Avoid generating duplicate orders if the user already has a pending order for this week
    const nextMonday = new Date(targetMonday);
    nextMonday.setDate(targetMonday.getDate() + 7);

    const existingPending = await prisma.order.findFirst({
      where: {
        userId,
        status: 'PENDING',
        createdAt: {
          gte: targetMonday,
          lt: nextMonday,
        },
      },
    });

    if (existingPending) {
      // Skip user to prevent duplicates
      continue;
    }

    const slot = userSubs[0].pickupSlot;
    let batchId = slot ? await findOrCreateBatchForSlot(slot) : null;
    if (batchId) {
      const associatedBatch = await prisma.batch.findUnique({ where: { id: batchId } });
      if (associatedBatch && associatedBatch.status === 'LOCKED') {
        batchId = null;
      }
    }

    await prisma.order.create({
      data: {
        userId,
        status: 'PENDING',
        pickupSlot: slot,
        batchId: batchId,
        items: {
          create: userSubs.map((sub) => ({
            productVariantId: sub.productVariantId,
            quantity: sub.quantity,
          })),
        },
      },
    });

    generatedCount++;
  }

  return generatedCount;
}

// 5. Generate Weekly Orders from Subscriptions (Admin only)
router.post('/generate-orders', authenticateToken, requireAdmin, async (req: AuthenticatedRequest, res: Response) => {
  try {
    const generatedCount = await runSubscriptionOrderGeneration();

    return res.json({
      message: `Successfully processed subscriptions and generated orders for ${generatedCount} customer(s).`,
      count: generatedCount,
    });
  } catch (error) {
    console.error('Error generating weekly subscription orders:', error);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

export default router;
