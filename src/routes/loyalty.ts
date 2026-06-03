import { Router, Response } from 'express';
import prisma from '../prisma';
import { authenticateToken, requireApproved, requireAdmin, AuthenticatedRequest } from '../middleware/auth';

const router = Router();

// GET /api/loyalty/status - Get loyalty status for the logged-in user or a specified user (Admin only)
router.get('/status', authenticateToken, requireApproved, async (req: AuthenticatedRequest, res: Response) => {
  if (!req.user) return res.status(401).json({ error: 'Unauthorized' });

  // Admins can query other users' status by passing userId
  let targetUserId = req.user.id;
  if (req.user.role === 'ADMIN' && typeof req.query.userId === 'string') {
    targetUserId = req.query.userId;
  }

  try {
    const user = await prisma.user.findUnique({
      where: { id: targetUserId },
      select: { id: true, name: true, email: true, phone: true }
    });

    if (!user) {
      return res.status(404).json({ error: 'User not found' });
    }

    // Fetch all COMPLETED orders for the target user
    const completedOrders = await prisma.order.findMany({
      where: {
        userId: targetUserId,
        status: 'COMPLETED'
      },
      include: {
        items: {
          include: {
            productVariant: {
              include: {
                product: true
              }
            }
          }
        }
      },
      orderBy: { createdAt: 'desc' }
    });

    // Calculate total items bought
    let totalItemsBought = 0;
    const purchaseLedger: Array<{
      orderId: string;
      date: Date;
      productName: string;
      size: string;
      quantity: number;
      price: number;
    }> = [];

    completedOrders.forEach(order => {
      order.items.forEach(item => {
        const paidQuantity = item.quantity - (item.couponApplied || 0);
        totalItemsBought += paidQuantity;
        purchaseLedger.push({
          orderId: order.id,
          date: order.createdAt,
          productName: item.productVariant.product.name,
          size: item.productVariant.size,
          quantity: item.quantity,
          price: item.productVariant.price,
          couponApplied: item.couponApplied || 0
        } as any);
      });
    });

    const freeEarned = Math.floor(totalItemsBought / 10);

    // Fetch total redeemed loaves from settings model
    const redemptionKey = `loyalty_redeemed:${targetUserId}`;
    const redemptionSetting = await prisma.setting.findUnique({
      where: { key: redemptionKey }
    });
    const freeRedeemed = redemptionSetting ? parseInt(redemptionSetting.value, 10) : 0;
    const freeRemaining = Math.max(0, freeEarned - freeRedeemed);
    const currentProgress = totalItemsBought % 10;

    return res.json({
      user,
      totalItemsBought,
      freeEarned,
      freeRedeemed,
      freeRemaining,
      currentProgress,
      stampsToNextFree: 10 - currentProgress,
      purchaseLedger
    });
  } catch (error) {
    console.error('Error fetching loyalty status:', error);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

// GET /api/loyalty/admin - List all customer loyalty progresses (Admin only)
router.get('/admin', authenticateToken, requireAdmin, async (req: AuthenticatedRequest, res: Response) => {
  try {
    // Fetch all CUSTOMERs
    const customers = await prisma.user.findMany({
      where: { role: 'CUSTOMER' },
      select: { id: true, name: true, email: true, phone: true, createdAt: true }
    });

    // Compile loyalty status for each customer
    const results = await Promise.all(customers.map(async (customer) => {
      const completedOrders = await prisma.order.findMany({
        where: {
          userId: customer.id,
          status: 'COMPLETED'
        },
        include: {
          items: {
            include: {
              productVariant: {
                include: {
                  product: true
                }
              }
            }
          }
        }
      });

      let totalItemsBought = 0;
      completedOrders.forEach(order => {
        order.items.forEach(item => {
          totalItemsBought += item.quantity - (item.couponApplied || 0);
        });
      });

      const freeEarned = Math.floor(totalItemsBought / 10);
      const redemptionKey = `loyalty_redeemed:${customer.id}`;
      const redemptionSetting = await prisma.setting.findUnique({
        where: { key: redemptionKey }
      });
      const freeRedeemed = redemptionSetting ? parseInt(redemptionSetting.value, 10) : 0;
      const freeRemaining = Math.max(0, freeEarned - freeRedeemed);
      const currentProgress = totalItemsBought % 10;

      return {
        id: customer.id,
        name: customer.name,
        email: customer.email,
        phone: customer.phone,
        createdAt: customer.createdAt,
        totalItemsBought,
        freeEarned,
        freeRedeemed,
        freeRemaining,
        currentProgress
      };
    }));

    return res.json({ customers: results });
  } catch (error) {
    console.error('Error fetching admin loyalty list:', error);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

// POST /api/loyalty/redeem - Redeem a free loaf for a customer (Admin only)
router.post('/redeem', authenticateToken, requireAdmin, async (req: AuthenticatedRequest, res: Response) => {
  const { userId } = req.body;
  if (!userId) {
    return res.status(400).json({ error: 'User ID is required' });
  }

  try {
    const user = await prisma.user.findUnique({
      where: { id: userId }
    });

    if (!user) {
      return res.status(404).json({ error: 'User not found' });
    }

    // Calculate total earned rewards
    const completedOrders = await prisma.order.findMany({
      where: {
        userId,
        status: 'COMPLETED'
      },
      include: {
        items: true
      }
    });

    let totalItemsBought = 0;
    completedOrders.forEach(order => {
      order.items.forEach(item => {
        totalItemsBought += item.quantity;
      });
    });

    const freeEarned = Math.floor(totalItemsBought / 10);

    // Fetch current redemption count
    const redemptionKey = `loyalty_redeemed:${userId}`;
    const redemptionSetting = await prisma.setting.findUnique({
      where: { key: redemptionKey }
    });
    const currentRedeemed = redemptionSetting ? parseInt(redemptionSetting.value, 10) : 0;

    if (currentRedeemed >= freeEarned) {
      return res.status(400).json({ error: 'User does not have any remaining free loaves to redeem.' });
    }

    const nextRedeemedCount = currentRedeemed + 1;

    // Save/Upsert new redeemed count
    await prisma.setting.upsert({
      where: { key: redemptionKey },
      update: { value: String(nextRedeemedCount) },
      create: { key: redemptionKey, value: String(nextRedeemedCount) }
    });

    return res.json({
      message: 'Successfully redeemed 1 free loaf!',
      totalItemsBought,
      freeEarned,
      freeRedeemed: nextRedeemedCount,
      freeRemaining: freeEarned - nextRedeemedCount,
      currentProgress: totalItemsBought % 10
    });
  } catch (error) {
    console.error('Error redeeming loyalty loaf:', error);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

export default router;
