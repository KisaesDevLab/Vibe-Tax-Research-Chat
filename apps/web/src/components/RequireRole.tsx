// Phase 3 — route guards.
import { Navigate, Outlet, useLocation } from 'react-router-dom';
import { useAuth } from './AuthProvider';
import type { Role } from '@vibe/shared';

export function RequireAuth() {
  const { user, loading } = useAuth();
  const location = useLocation();
  if (loading) return <div className="p-8 text-ink/60">Loading…</div>;
  if (!user) return <Navigate to="/login" state={{ from: location }} replace />;
  return <Outlet />;
}

export function RequireRole({ role }: { role: Role | Role[] }) {
  const { user } = useAuth();
  const allowed = Array.isArray(role) ? role : [role];
  if (!user) return <Navigate to="/login" replace />;
  if (!allowed.includes(user.role)) {
    return (
      <div className="p-8 text-ink/70">
        <h2 className="font-display text-2xl mb-2">Forbidden</h2>
        <p>You don&apos;t have permission to view this page.</p>
      </div>
    );
  }
  return <Outlet />;
}
