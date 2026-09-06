import type { Request, Response, NextFunction } from 'express';
import { supabase } from './supabase.js';

export interface AuthenticatedRequest extends Request {
  userId: string;
  userEmail: string;
}

export async function authenticateAccessToken(accessToken?: string): Promise<string | null> {
  if (!supabase) return 'dev-user';
  if (!accessToken) return null;

  const { data: { user }, error } = await supabase.auth.getUser(accessToken);
  return error || !user ? null : user.id;
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
  const { data: { user }, error } = await supabase.auth.getUser(token);

  if (error || !user) {
    res.status(401).json({ error: 'Invalid or expired token' });
    return;
  }

  (req as AuthenticatedRequest).userId = user.id;
  (req as AuthenticatedRequest).userEmail = user.email ?? '';
  next();
}
