import { Router, Response } from 'express';
import prisma from '../prisma';
import { authenticateToken, requireApproved, requireAdmin, AuthenticatedRequest } from '../middleware/auth';

const router = Router();

// 1. Get orders (Admin sees all, Customer sees only their own)
router.get('/', authenticateToken, requireApproved, async (req: AuthenticatedRequest, res: Response) => {
  if (!req.user) return res.status(401).json({ error: 'Unauthorized' });

  try {
    let orders;
    if (req.user.role === 'ADMIN') {
      orders = await prisma.order.findMany({
        include: {
          user: {
            select: { id: true, name: true, email: true, phone: true },
          },
          items: {
            include: {
              productVariant: {
                include: {
                  product: true,
                },
              },
            },
          },
          batch: true,
        },
        orderBy: { createdAt: 'desc' },
      });
    } else {
      orders = await prisma.order.findMany({
        where: { userId: req.user.id },
        include: {
          items: {
            include: {
              productVariant: {
                include: {
                  product: true,
                },
              },
            },
          },
          batch: true,
        },
        orderBy: { createdAt: 'desc' },
      });
    }

    return res.json({ orders });
  } catch (error) {
    console.error('Error fetching orders:', error);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

// Helper to find or automatically create a draft production batch for a given pickup date
export async function findOrCreateBatchForSlot(pickupSlot: string): Promise<string> {
  const allBatches = await prisma.batch.findMany();
  const matchingBatch = allBatches.find(b => {
    const bDateStr = b.date.toISOString().split('T')[0];
    return bDateStr === pickupSlot;
  });

  if (matchingBatch) {
    return matchingBatch.id;
  }

  const dateParts = pickupSlot.split('-');
  let batchDate = new Date();
  if (dateParts.length === 3) {
    const year = parseInt(dateParts[0], 10);
    const month = parseInt(dateParts[1], 10);
    const day = parseInt(dateParts[2], 10);
    // MIDDAY to avoid any standard timezone shifts on frontend/backend roundtripping
    batchDate = new Date(year, month - 1, day, 12, 0, 0, 0);
  }

  const newBatch = await prisma.batch.create({
    data: {
      date: batchDate,
      status: 'DRAFT',
    },
  });

  return newBatch.id;
}

// 2. Submit a new order (Approved Customers only)
// Body structure: { items: [ { productVariantId: "uuid", quantity: 2 }, ... ] }
router.post('/', authenticateToken, requireApproved, async (req: AuthenticatedRequest, res: Response) => {
  if (!req.user) return res.status(401).json({ error: 'Unauthorized' });
  const { items, pickupSlot, internalCustomer, status } = req.body;

  if (!Array.isArray(items) || items.length === 0) {
    return res.status(400).json({ error: 'Order must contain at least one item' });
  }

  // Validate item values
  for (const item of items) {
    if (!item.productVariantId || typeof item.quantity !== 'number' || item.quantity <= 0) {
      return res.status(400).json({ error: 'Invalid variant ID or quantity' });
    }
  }

  try {
    // Lead-time cut-off validation for non-admin customers
    if (req.user.role !== 'ADMIN' && pickupSlot) {
      const leadTimeSetting = await prisma.setting.findUnique({
        where: { key: 'leadTimeHours' }
      });
      const leadTimeHours = leadTimeSetting ? parseInt(leadTimeSetting.value, 10) : 72;

      const bakeTimeSetting = await prisma.setting.findUnique({
        where: { key: 'bakeTimeOfDay' }
      });
      const bakeTimeStr = bakeTimeSetting ? bakeTimeSetting.value : '06:00';
      let startHours = 6;
      let startMinutes = 0;
      if (bakeTimeStr.includes(':')) {
        const parts = bakeTimeStr.split(':');
        startHours = parseInt(parts[0], 10) || 6;
        startMinutes = parseInt(parts[1], 10) || 0;
      }
      
      const dateParts = pickupSlot.split('-');
      if (dateParts.length === 3) {
        const year = parseInt(dateParts[0], 10);
        const month = parseInt(dateParts[1], 10);
        const day = parseInt(dateParts[2], 10);
        
        const bakeStart = new Date(year, month - 1, day, startHours, startMinutes, 0, 0);
        const deadline = new Date(bakeStart.getTime() - leadTimeHours * 60 * 60 * 1000);
        
        if (new Date() >= deadline) {
          return res.status(400).json({ 
            error: 'The ordering deadline for this baking day has passed.' 
          });
        }
      }
    }

    let targetUserId = req.user.id;

    if (internalCustomer && req.user.role === 'ADMIN') {
      const { name, phone, email } = internalCustomer;
      if (!name) {
        return res.status(400).json({ error: 'Internal customer name is required' });
      }

      // Search for existing guest/customer user
      let customerUser = null;

      // 1. Search by email if provided
      if (email) {
        customerUser = await prisma.user.findUnique({
          where: { email }
        });
      }

      // 2. Search by phone if provided and not found by email
      if (!customerUser && phone) {
        customerUser = await prisma.user.findFirst({
          where: { phone }
        });
      }

      // 3. Create if not exists
      if (!customerUser) {
        const safeEmail = email || `internal_${Date.now()}_${Math.floor(Math.random() * 1000)}@internal.bakery.com`;
        customerUser = await prisma.user.create({
          data: {
            name,
            email: safeEmail,
            phone: phone || null,
            role: 'CUSTOMER',
            status: 'APPROVED',
            password: null // Passwordless internal guest profile
          }
        });
      } else {
        // Update phone if provided but missing
        if (phone && !customerUser.phone) {
          customerUser = await prisma.user.update({
            where: { id: customerUser.id },
            data: { phone }
          });
        }
      }

      targetUserId = customerUser.id;
    }

    // Default to 'CONFIRMED' for admin-created internal orders, 'PENDING' for normal clients
    const defaultStatus = req.user.role === 'ADMIN' ? 'CONFIRMED' : 'PENDING';
    const finalStatus = (status && ['PENDING', 'CONFIRMED', 'IN_PRODUCTION', 'BAKED', 'COMPLETED'].includes(status)) ? status : defaultStatus;

    // Calculate total coupons applied in the incoming request
    let totalCouponsApplied = 0;
    items.forEach((item: any) => {
      if (item.couponApplied && typeof item.couponApplied === 'number') {
        totalCouponsApplied += item.couponApplied;
      }
    });

    if (totalCouponsApplied > 0) {
      // 1. Fetch completed orders to see total earned
      const completedOrders = await prisma.order.findMany({
        where: { userId: targetUserId, status: 'COMPLETED' },
        include: { items: true }
      });

      let totalItemsBought = 0;
      completedOrders.forEach(order => {
        order.items.forEach(item => {
          totalItemsBought += item.quantity;
        });
      });

      const freeEarned = Math.floor(totalItemsBought / 10);

      // 2. Fetch already redeemed count from settings
      const redemptionKey = `loyalty_redeemed:${targetUserId}`;
      const redemptionSetting = await prisma.setting.findUnique({
        where: { key: redemptionKey }
      });
      const currentRedeemed = redemptionSetting ? parseInt(redemptionSetting.value, 10) : 0;
      const freeRemaining = Math.max(0, freeEarned - currentRedeemed);

      if (totalCouponsApplied > freeRemaining) {
        return res.status(400).json({ 
          error: `Insufficient loyalty free loaf coupons available. You applied ${totalCouponsApplied} coupon(s), but only have ${freeRemaining} available.` 
        });
      }

      // 3. Deduct coupons by incrementing the redeemed setting key
      const nextRedeemed = currentRedeemed + totalCouponsApplied;
      await prisma.setting.upsert({
        where: { key: redemptionKey },
        update: { value: String(nextRedeemed) },
        create: { key: redemptionKey, value: String(nextRedeemed) }
      });
    }

    let batchId: string | null = null;
    let autoFinalStatus = finalStatus;
    if (pickupSlot) {
      batchId = await findOrCreateBatchForSlot(pickupSlot);
      const associatedBatch = await prisma.batch.findUnique({ where: { id: batchId } });
      if (associatedBatch) {
        if (associatedBatch.status === 'LOCKED') {
          return res.status(400).json({ error: 'This baking day is locked and in production. No new orders can be added.' });
        }
      }
    }

    const newOrder = await prisma.order.create({
      data: {
        userId: targetUserId,
        status: autoFinalStatus,
        pickupSlot: pickupSlot || null,
        batchId: batchId,
        items: {
          create: items.map((item: any) => ({
            productVariantId: item.productVariantId,
            quantity: item.quantity,
            couponApplied: item.couponApplied || 0,
          })),
        },
      },
      include: {
        items: {
          include: {
            productVariant: {
              include: {
                product: true,
              },
            },
          },
        },
      },
    });

    return res.status(201).json({ message: 'Order submitted successfully', order: newOrder });
  } catch (error) {
    console.error('Error submitting order:', error);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

// 3. Update order status (Admin only with State Machine Transition Validation)
router.put('/:id/status', authenticateToken, requireAdmin, async (req: AuthenticatedRequest, res: Response) => {
  const { id } = req.params;
  const { status } = req.body;

  if (!status || !['PENDING', 'CONFIRMED', 'IN_PRODUCTION', 'BAKED', 'COMPLETED'].includes(status)) {
    return res.status(400).json({ error: 'Valid status is required' });
  }

  try {
    const existingOrder = await prisma.order.findUnique({
      where: { id },
      include: { batch: true }
    });

    if (!existingOrder) {
      return res.status(404).json({ error: 'Order not found' });
    }

    // 1. Immutable batch lock safeguard
    if (existingOrder.batch && existingOrder.batch.status === 'LOCKED') {
      return res.status(400).json({ error: 'Cannot modify the status of an order belonging to a locked production batch.' });
    }

    // 2. Strict State Machine validation: PENDING → CONFIRMED → IN_PRODUCTION → BAKED → COMPLETED
    const currentStatus = existingOrder.status;
    const allowedTransitions: Record<string, string[]> = {
      'PENDING': ['CONFIRMED'],
      'CONFIRMED': ['IN_PRODUCTION', 'PENDING'],
      'IN_PRODUCTION': ['BAKED', 'CONFIRMED'],
      'BAKED': ['COMPLETED', 'IN_PRODUCTION'],
      'COMPLETED': ['BAKED']
    };

    if (currentStatus !== status) {
      const validNextStates = allowedTransitions[currentStatus] || [];
      if (!validNextStates.includes(status)) {
        return res.status(400).json({
          error: `Invalid status transition from ${currentStatus} to ${status}. Allowed order flow: PENDING → CONFIRMED → IN_PRODUCTION → BAKED → COMPLETED`
        });
      }
    }

    const updatedOrder = await prisma.order.update({
      where: { id },
      data: { status },
      include: {
        user: { select: { name: true, email: true } },
        items: {
          include: {
            productVariant: {
              include: {
                product: true,
              },
            },
          },
        },
      },
    });

    return res.json({ message: `Order status updated to ${status}`, order: updatedOrder });
  } catch (error) {
    console.error('Error updating order status:', error);
    return res.status(500).json({ error: 'Internal server error or order not found' });
  }
});

// 3.5 Update order details (Admin only, e.g. for changing pickupSlot/baking date)
router.put('/:id', authenticateToken, requireAdmin, async (req: AuthenticatedRequest, res: Response) => {
  const { id } = req.params;
  const { pickupSlot, status, batchId } = req.body;

  try {
    const existingOrder = await prisma.order.findUnique({
      where: { id },
      include: { batch: true }
    });

    if (!existingOrder) {
      return res.status(404).json({ error: 'Order not found' });
    }

    // Immutable batch lock safeguard for existing batch
    if (existingOrder.batch && existingOrder.batch.status === 'LOCKED') {
      return res.status(400).json({ error: 'Cannot modify details of an order belonging to a locked production batch.' });
    }

    const updateData: any = {};
    if (pickupSlot !== undefined) {
      updateData.pickupSlot = pickupSlot;
      
      if (pickupSlot) {
        const newBatchId = await findOrCreateBatchForSlot(pickupSlot);
        updateData.batchId = newBatchId;
        
        const matchingBatch = await prisma.batch.findUnique({ where: { id: newBatchId } });
        if (matchingBatch) {
          // If the matching target batch is locked, block moving to it
          if (matchingBatch.status === 'LOCKED') {
            return res.status(400).json({ error: 'Cannot move an order to a locked production batch.' });
          }
          // Default status scaling
          if (existingOrder.status === 'IN_PRODUCTION' && status === undefined) {
            updateData.status = 'CONFIRMED';
          }
        }
      } else {
        updateData.batchId = null; // Unbatch if pickupSlot is cleared
        if (existingOrder.status === 'IN_PRODUCTION' && status === undefined) {
          updateData.status = 'CONFIRMED';
        }
      }
    }

    if (batchId !== undefined) {
      updateData.batchId = batchId;
      if (batchId) {
        const targetBatch = await prisma.batch.findUnique({ where: { id: batchId } });
        if (targetBatch && targetBatch.status === 'LOCKED') {
          return res.status(400).json({ error: 'Cannot move an order to a locked production batch.' });
        }
      }
      if (batchId === null && existingOrder.status === 'IN_PRODUCTION' && status === undefined) {
        updateData.status = 'CONFIRMED';
      }
    }

    if (status !== undefined) {
      if (['PENDING', 'CONFIRMED', 'IN_PRODUCTION', 'BAKED', 'COMPLETED'].includes(status)) {
        // Enforce state transitions on detailed update
        const currentStatus = existingOrder.status;
        const allowedTransitions: Record<string, string[]> = {
          'PENDING': ['CONFIRMED'],
          'CONFIRMED': ['IN_PRODUCTION', 'PENDING'],
          'IN_PRODUCTION': ['BAKED', 'CONFIRMED'],
          'BAKED': ['COMPLETED', 'IN_PRODUCTION'],
          'COMPLETED': ['BAKED']
        };

        if (currentStatus !== status) {
          const validNextStates = allowedTransitions[currentStatus] || [];
          if (!validNextStates.includes(status)) {
            return res.status(400).json({
              error: `Invalid status transition from ${currentStatus} to ${status}. Allowed order flow: PENDING → CONFIRMED → IN_PRODUCTION → BAKED → COMPLETED`
            });
          }
        }
        updateData.status = status;
      } else {
        return res.status(400).json({ error: 'Invalid status value' });
      }
    }

    const updatedOrder = await prisma.order.update({
      where: { id },
      data: updateData,
      include: {
        user: { select: { id: true, name: true, email: true, phone: true } },
        items: {
          include: {
            productVariant: {
              include: {
                product: true,
              },
            },
          },
        },
      },
    });

    const oldBatchId = existingOrder.batchId;
    if (oldBatchId && updatedOrder.batchId !== oldBatchId) {
      const remainingCount = await prisma.order.count({
        where: { batchId: oldBatchId },
      });
      if (remainingCount === 0) {
        await prisma.batch.delete({
          where: { id: oldBatchId },
        });
      }
    }

    return res.json({ message: 'Order updated successfully', order: updatedOrder });
  } catch (error) {
    console.error('Error updating order:', error);
    return res.status(500).json({ error: 'Internal server error or order not found' });
  }
});

// 4. Cancel/Delete an order (Customer if pending, Admin can delete any)
router.delete('/:id', authenticateToken, requireApproved, async (req: AuthenticatedRequest, res: Response) => {
  if (!req.user) return res.status(401).json({ error: 'Unauthorized' });
  const { id } = req.params;

  try {
    const order = await prisma.order.findUnique({
      where: { id },
      include: { batch: true }
    });

    if (!order) {
      return res.status(404).json({ error: 'Order not found' });
    }

    // Immutable batch lock safeguard
    if (order.batch && order.batch.status === 'LOCKED') {
      return res.status(400).json({ error: 'Cannot cancel or delete an order belonging to a locked production batch.' });
    }

    // Role-based deletion logic
    if (req.user.role !== 'ADMIN') {
      if (order.userId !== req.user.id) {
        return res.status(403).json({ error: 'Cannot cancel another user\'s order' });
      }
      if (order.status !== 'PENDING') {
        return res.status(400).json({ error: 'Only pending orders can be canceled' });
      }
    }

    const batchId = order.batchId;

    await prisma.order.delete({
      where: { id },
    });

    if (batchId) {
      const remainingCount = await prisma.order.count({
        where: { batchId },
      });
      if (remainingCount === 0) {
        await prisma.batch.delete({
          where: { id: batchId },
        });
      }
    }

    return res.json({ message: 'Order successfully canceled' });
  } catch (error) {
    console.error('Error deleting order:', error);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

// GET /api/orders/:id/metadata - Fetch metadata for an order
router.get('/:id/metadata', authenticateToken, requireAdmin, async (req: AuthenticatedRequest, res: Response) => {
  const { id } = req.params;
  try {
    const metaKey = `order_meta:${id}`;
    const setting = await prisma.setting.findUnique({
      where: { key: metaKey }
    });
    return res.json(setting ? JSON.parse(setting.value) : {});
  } catch (error) {
    console.error('Error fetching order metadata:', error);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

// POST /api/orders/:id/metadata - Update metadata for an order
router.post('/:id/metadata', authenticateToken, requireAdmin, async (req: AuthenticatedRequest, res: Response) => {
  const { id } = req.params;
  const metadata = req.body;
  try {
    const metaKey = `order_meta:${id}`;
    await prisma.setting.upsert({
      where: { key: metaKey },
      update: { value: JSON.stringify(metadata) },
      create: { key: metaKey, value: JSON.stringify(metadata) }
    });
    return res.json({ message: 'Metadata updated successfully', metadata });
  } catch (error) {
    console.error('Error updating order metadata:', error);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

export default router;
