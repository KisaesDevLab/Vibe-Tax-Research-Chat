// Phase 3 — auth middleware: requireAuth + requireRole.
import type { Request, Response, NextFunction } from 'express';
import { verifyAccess } from '../lib/jwt.js';
import type { Role } from '@vibe/shared';

// Augment Express Request with auth context. Global form works with
// @types/express 4 + 5 alike.
declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      auth?: {
        user_id: string;
        email: string;
        role: Role;
      };
    }
  }
}

export function requireAuth(req: Request, res: Response, next: NextFunction): void {
  const header = req.headers.authorization;
  if (!header?.startsWith('Bearer ')) {
    res.status(401).json({ error: 'unauthorized' });
    return;
  }
  const token = header.slice('Bearer '.length);
  try {
    const claims = verifyAccess(token);
    req.auth = { user_id: claims.sub, email: claims.email, role: claims.role };
    next();
  } catch {
    res.status(401).json({ error: 'invalid_token' });
  }
}

export function requireRole(...roles: Role[]) {
  return (req: Request, res: Response, next: NextFunction): void => {
    if (!req.auth) {
      res.status(401).json({ error: 'unauthorized' });
      return;
    }
    if (!roles.includes(req.auth.role)) {
      res.status(403).json({ error: 'forbidden', required_role: roles });
      return;
    }
    next();
  };
}
