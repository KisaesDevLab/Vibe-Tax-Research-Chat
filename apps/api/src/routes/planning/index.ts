// TP-6 — planning module API root: /api/planning/*. Everything behind
// auth + the planning flag.
import { Router } from 'express';
import { requireAuth } from '../../middleware/auth.js';
import { requirePlanning } from '../../middleware/planning-flag.js';
import { planningStrategiesRouter } from './strategies.js';
import { plansRouter } from './plans.js';

export const planningRouter = Router();
planningRouter.use(requireAuth, requirePlanning);
planningRouter.use('/strategies', planningStrategiesRouter);
planningRouter.use('/plans', plansRouter);
