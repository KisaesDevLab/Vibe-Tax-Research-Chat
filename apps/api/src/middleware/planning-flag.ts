// TP-0 — gate for every Planning/Clients API surface. Responds 404 (not
// 403) when the planning module is disabled so the routes are
// indistinguishable from not existing, per the master plan's
// "research unchanged with the flag off" ground rule.
import type { RequestHandler } from 'express';
import { SETTING_KEYS } from '@vibe/db/schema';
import { getSetting } from '../lib/settings-store.js';

export const requirePlanning: RequestHandler = async (req, res, next) => {
  const enabled = await getSetting<boolean>(SETTING_KEYS.PLANNING_ENABLED);
  if (enabled !== true) {
    res.status(404).json({ error: 'not_found', path: req.originalUrl });
    return;
  }
  next();
};
