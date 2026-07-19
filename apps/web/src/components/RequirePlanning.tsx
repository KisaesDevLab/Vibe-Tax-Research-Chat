// TP-1 — route guard for /planning and /clients. Waits for the config
// fetch (so deep links don't bounce before the flag is known), then
// redirects to /research when the planning module is disabled.
import { Navigate, Outlet } from 'react-router-dom';
import { useAppConfig } from '../lib/app-config';

export function RequirePlanning() {
  const { config, loading } = useAppConfig();
  if (loading) return <div className="p-8 text-ink/60">Loading…</div>;
  if (!config.planning_enabled) return <Navigate to="/research" replace />;
  return <Outlet />;
}
