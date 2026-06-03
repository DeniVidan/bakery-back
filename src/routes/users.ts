import { Router, Response } from 'express';
import prisma from '../prisma';
import { authenticateToken, requireAdmin, AuthenticatedRequest } from '../middleware/auth';

const router = Router();

// Get all users (Admin only)
router.get('/', authenticateToken, requireAdmin, async (req: AuthenticatedRequest, res: Response) => {
  try {
    const users = await prisma.user.findMany({
      orderBy: { createdAt: 'desc' },
      select: {
        id: true,
        name: true,
        email: true,
        role: true,
        status: true,
        createdAt: true,
      },
    });
    return res.json({ users });
  } catch (error) {
    console.error('Error listing users:', error);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

// Update user status (Admin only: APPROVED, PENDING, REJECTED)
router.put('/:id/status', authenticateToken, requireAdmin, async (req: AuthenticatedRequest, res: Response) => {
  const { id } = req.params;
  const { status } = req.body;

  if (!status || !['PENDING', 'APPROVED', 'REJECTED'].includes(status)) {
    return res.status(400).json({ error: 'Valid status is required' });
  }

  try {
    // Prevent locking out the current logged-in admin from self-modification
    if (id === req.user?.id) {
      return res.status(400).json({ error: 'Cannot change your own registration status' });
    }

    const updatedUser = await prisma.user.update({
      where: { id },
      data: { status },
      select: { id: true, name: true, email: true, status: true, role: true },
    });

    return res.json({
      message: `User registration status successfully updated to ${status}`,
      user: updatedUser,
    });
  } catch (error) {
    console.error('Error changing user status:', error);
    return res.status(500).json({ error: 'Internal server error or user not found' });
  }
});

// Update user role (Admin only: ADMIN, CUSTOMER)
router.put('/:id/role', authenticateToken, requireAdmin, async (req: AuthenticatedRequest, res: Response) => {
  const { id } = req.params;
  const { role } = req.body;

  if (!role || !['ADMIN', 'CUSTOMER'].includes(role)) {
    return res.status(400).json({ error: 'Valid role is required' });
  }

  try {
    if (id === req.user?.id) {
      return res.status(400).json({ error: 'Cannot change your own role to prevent administrator lockout' });
    }

    const updatedUser = await prisma.user.update({
      where: { id },
      data: { role },
      select: { id: true, name: true, email: true, role: true, status: true },
    });

    return res.json({
      message: `User role successfully updated to ${role}`,
      user: updatedUser,
    });
  } catch (error) {
    console.error('Error changing user role:', error);
    return res.status(500).json({ error: 'Internal server error or user not found' });
  }
});

export default router;
