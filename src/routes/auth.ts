import { Router, Request, Response } from 'express';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import prisma from '../prisma';
import { authenticateToken, AuthenticatedRequest } from '../middleware/auth';

const router = Router();
const JWT_SECRET = process.env.JWT_SECRET || 'super-secret-bakery-key-change-me-in-production';

// Helper to generate JWT
const generateToken = (userId: string, email: string) => {
  return jwt.sign({ id: userId, email }, JWT_SECRET, { expiresIn: '7d' });
};

// 1. Email/Password Signup
router.post('/register', async (req: Request, res: Response) => {
  const { name, email, password, phone } = req.body;

  if (!name || !email || !password) {
    return res.status(400).json({ error: 'Name, email, and password are required' });
  }

  try {
    const existingUser = await prisma.user.findUnique({ where: { email: email.toLowerCase() } });
    if (existingUser) {
      return res.status(400).json({ error: 'User with this email already exists' });
    }

    const hashedPassword = await bcrypt.hash(password, 10);

    // First user is automatically approved and given ADMIN role
    const usersCount = await prisma.user.count();
    const isFirstUser = usersCount === 0;

    const newUser = await prisma.user.create({
      data: {
        name,
        email: email.toLowerCase(),
        password: hashedPassword,
        phone: phone || null,
        role: isFirstUser ? 'ADMIN' : 'CUSTOMER',
        status: isFirstUser ? 'APPROVED' : 'PENDING',
      },
    });

    const token = generateToken(newUser.id, newUser.email);

    return res.status(201).json({
      message: 'Registration successful',
      token,
      user: {
        id: newUser.id,
        name: newUser.name,
        email: newUser.email,
        phone: newUser.phone,
        role: newUser.role,
        status: newUser.status,
      },
    });
  } catch (error) {
    console.error('Error during registration:', error);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

// 2. Email/Password Login
router.post('/login', async (req: Request, res: Response) => {
  const { email, password } = req.body;

  if (!email || !password) {
    return res.status(400).json({ error: 'Email and password are required' });
  }

  try {
    const user = await prisma.user.findUnique({ where: { email: email.toLowerCase() } });
    if (!user || !user.password) {
      return res.status(401).json({ error: 'Invalid email or password' });
    }

    const isMatch = await bcrypt.compare(password, user.password);
    if (!isMatch) {
      return res.status(401).json({ error: 'Invalid email or password' });
    }

    const token = generateToken(user.id, user.email);

    return res.json({
      message: 'Login successful',
      token,
      user: {
        id: user.id,
        name: user.name,
        email: user.email,
        phone: user.phone,
        role: user.role,
        status: user.status,
      },
    });
  } catch (error) {
    console.error('Error during login:', error);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

// 3. Google OAuth Verification (Includes quick local simulation flow)
router.post('/google', async (req: Request, res: Response) => {
  const { name, email, googleId, picture } = req.body;

  if (!email || !name) {
    return res.status(400).json({ error: 'Incomplete Google OAuth profile data' });
  }

  try {
    // Check if user exists
    let user = await prisma.user.findUnique({ where: { email: email.toLowerCase() } });

    if (!user) {
      const usersCount = await prisma.user.count();
      const isFirstUser = usersCount === 0;

      user = await prisma.user.create({
        data: {
          name,
          email: email.toLowerCase(),
          role: isFirstUser ? 'ADMIN' : 'CUSTOMER',
          status: isFirstUser ? 'APPROVED' : 'PENDING',
        },
      });
    }

    const token = generateToken(user.id, user.email);

    return res.json({
      message: 'Google login successful',
      token,
      user: {
        id: user.id,
        name: user.name,
        email: user.email,
        phone: user.phone,
        role: user.role,
        status: user.status,
      },
    });
  } catch (error) {
    console.error('Error during Google login:', error);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

// 4. Session Me
router.get('/me', authenticateToken, async (req: AuthenticatedRequest, res: Response) => {
  if (!req.user) return res.status(401).json({ error: 'Not authenticated' });
  
  try {
    const user = await prisma.user.findUnique({
      where: { id: req.user.id },
      select: {
        id: true,
        name: true,
        email: true,
        phone: true,
        role: true,
        status: true,
        createdAt: true
      }
    });

    if (!user) {
      return res.status(404).json({ error: 'User not found' });
    }

    return res.json({ user });
  } catch (error) {
    return res.status(500).json({ error: 'Internal server error' });
  }
});

// 5. Update Profile (Phone & Name)
router.put('/profile', authenticateToken, async (req: AuthenticatedRequest, res: Response) => {
  if (!req.user) return res.status(401).json({ error: 'Not authenticated' });
  const { name, phone } = req.body;

  try {
    const updatedUser = await prisma.user.update({
      where: { id: req.user.id },
      data: {
        name: name || undefined,
        phone: phone !== undefined ? phone : undefined,
      },
      select: {
        id: true,
        name: true,
        email: true,
        phone: true,
        role: true,
        status: true,
        createdAt: true,
      },
    });

    return res.json({ message: 'Profile updated successfully', user: updatedUser });
  } catch (error) {
    console.error('Error updating profile:', error);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

export default router;
