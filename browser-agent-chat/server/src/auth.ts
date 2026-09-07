import type { Request, Response, NextFunction } from 'express';
import { supabase, verifyToken, type AuthenticatedUser } from './supabase.js';

export interface AuthenticatedRequest extends Request {
  userId: string;
  userEmail: string;
}

export async function requireAuth(req: Request, res: Response, next: NextFunction): Promise<void> {
  if (!supabase) {
    // Dev mode: no auth required, use a placeholder user
    (req as AuthenticatedRequest).userId = 'dev-user';
    (req as AuthenticatedRequest).userEmail = 'dev@local';
    next();
    return;
  }

  const authHeader = req.headers.authorization;
  if (!authHeader?.startsWith('Bearer ')) {
    res.status(401).json({ error: 'Missing authorization header' });
    return;
  }

  const token = authHeader.slice(7);
  let user: AuthenticatedUser;
  try {
    user = await verifyToken(token);
  } catch {
    res.status(401).json({ error: 'Invalid or expired token' });
    return;
  }

  (req as AuthenticatedRequest).userId = user.id;
  (req as AuthenticatedRequest).userEmail = user.email;
  next();
}
