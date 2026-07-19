// TP-0 — public (authenticated) app config. The web client reads this once
// at boot to decide which modules to render; it must stay cheap and must
// never surface secrets or admin-only settings.
import { Router } from 'express';
import { SETTING_KEYS } from '@vibe/db/schema';
import { requireAuth } from '../middleware/auth.js';
import { getSetting } from '../lib/settings-store.js';

export const configRouter = Router();
configRouter.use(requireAuth);

configRouter.get('/', async (_req, res) => {
  const planningEnabled = await getSetting<boolean>(SETTING_KEYS.PLANNING_ENABLED);
  res.json({ planning_enabled: planningEnabled === true });
});
