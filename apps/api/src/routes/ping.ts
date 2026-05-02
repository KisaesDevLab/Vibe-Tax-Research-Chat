// Cheap liveness probe with no DB or Redis dependency. Used by the
// Vibe-Appliance bootstrapper and by the emergency-access HAProxy frontend
// at port 5191 — both want to know that the API process is up even when
// Postgres or Redis are themselves degraded. /api/health/deep covers the
// dependency-aware check.
import { Router } from 'express';

export const pingRouter = Router();

pingRouter.get('/', (_req, res) => {
  res.json({ ok: true });
});
