import { Request, Response, NextFunction } from 'express';
import jwt from 'jsonwebtoken';
import prisma from '../prisma';

export interface AuthenticatedRequest extends Request {
  user?: {
    id: string;
    email: string;
    role: 'ADMIN' | 'CUSTOMER';
    status: 'PENDING' | 'APPROVED' | 'REJECTED';
  };
}

const JWT_SECRET = process.env.JWT_SECRET || 'super-secret-bakery-key-change-me-in-production';

export const authenticateToken = async (
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction
) => {
  const authHeader = req.headers['authorization'];
  const token = authHeader && authHeader.split(' ')[1];

  if (!token) {
    return res.status(401).json({ error: 'Access token required' });
  }

  try {
    const decoded = jwt.verify(token, JWT_SECRET) as { id: string; email: string };
    
    // Fetch fresh user data to ensure up-to-date role/status
    const user = await prisma.user.findUnique({
      where: { id: decoded.id },
    });

    if (!user) {
      return res.status(403).json({ error: 'User no longer exists' });
    }

    req.user = {
      id: user.id,
      email: user.email,
      role: user.role,
      status: user.status,
    };

    next();
  } catch (err) {
    return res.status(403).json({ error: 'Invalid or expired token' });
  }
};

export const requireAdmin = (
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction
) => {
  if (!req.user || req.user.role !== 'ADMIN') {
    return res.status(403).json({ error: 'Admin privileges required' });
  }
  next();
};

export const requireApproved = (
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction
) => {
  if (!req.user) {
    return res.status(401).json({ error: 'Authentication required' });
  }

  // Admin bypasses approval check or is automatically approved
  if (req.user.role === 'ADMIN') {
    return next();
  }

  if (req.user.status !== 'APPROVED') {
    return res.status(403).json({
      error: `Your account status is ${req.user.status}. Only APPROVED customers can access these features.`,
    });
  }

  next();
};
