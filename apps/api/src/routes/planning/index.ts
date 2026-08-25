// TP-6 — planning module API root: /api/planning/*. Everything behind
// auth + the planning flag.
import { Router } from 'express';
import { eq } from 'drizzle-orm';
import { getDb } from '@vibe/db';
import { users } from '@vibe/db/schema';
import { requireAuth } from '../../middleware/auth.js';
import { requirePlanning } from '../../middleware/planning-flag.js';
import { planningStrategiesRouter } from './strategies.js';
import { plansRouter } from './plans.js';
import { intakeRouter } from './intake.js';
import { planWorkflowRouter } from './workflow.js';
import { deliverablesRouter } from './deliverables.js';
import { engagementRouter } from './engagement.js';
import { planMemoRouter } from './memo.js';
import { planChatRouter } from './plan-chat.js';
import { pendingFactsRouter } from './pending-facts.js';

export const planningRouter = Router();
planningRouter.use(requireAuth, requirePlanning);

// QA round 1 — reviewer picker data source. Any planning user can list
// potential reviewing partners (id + display identity only); assignment
// itself is a plan PATCH and the reviewer≠preparer rule is enforced at
// transition.
planningRouter.get('/reviewers', async (_req, res) => {
  const rows = await getDb()
    .select({ id: users.id, email: users.email, display_name: users.display_name })
    .from(users)
    .where(eq(users.is_active, true))
    .orderBy(users.email)
    .limit(200);
  res.json({ reviewers: rows });
});

planningRouter.use('/strategies', planningStrategiesRouter);
planningRouter.use('/plans/:id/intake', intakeRouter);
planningRouter.use('/plans/:id/deliverables', deliverablesRouter);
planningRouter.use('/plans/:id/engagement', engagementRouter);
planningRouter.use('/plans/:id/memo', planMemoRouter);
// TP-8a — plan-scoped chat launcher; before the catch-all workflow mount.
planningRouter.use('/plans/:id/chat', planChatRouter);
planningRouter.use('/plans/:id/pending-facts', pendingFactsRouter);
planningRouter.use('/plans/:id', planWorkflowRouter);
planningRouter.use('/plans', plansRouter);
