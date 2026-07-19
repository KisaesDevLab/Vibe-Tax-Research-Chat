// Phase 3 — login page.
import { useState, useEffect, type FormEvent } from 'react';
import { Navigate, useLocation, Link, useSearchParams } from 'react-router-dom';
import { useAuth } from '../components/AuthProvider';
import { api } from '../lib/api';

export function LoginPage() {
  const { user, login } = useAuth();
  const location = useLocation();
  const [searchParams] = useSearchParams();
  const resetOk = searchParams.get('reset') === 'ok';
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  // Detect a fresh appliance with no admin user yet and route the visitor
  // to /setup. Without this, the very first login attempt fails as
  // "invalid_credentials" with no hint of where to go.
  const [needsSetup, setNeedsSetup] = useState<boolean | null>(null);
  useEffect(() => {
    let cancelled = false;
    api<{ admin_exists: boolean }>('/api/setup/status', { skipRefresh: true })
      .then((r) => {
        if (!cancelled) setNeedsSetup(!r.admin_exists);
      })
      .catch(() => {
        if (!cancelled) setNeedsSetup(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  if (user) {
    const from =
      (location.state as { from?: { pathname: string } } | null)?.from?.pathname ?? '/research';
    return <Navigate to={from} replace />;
  }
  if (needsSetup) return <Navigate to="/setup" replace />;

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await login(email, password);
    } catch (err) {
      setError((err as Error).message ?? 'Login failed');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="min-h-screen grid place-items-center bg-paper px-4 py-8">
      <div className="w-full max-w-[380px] bg-white border border-ink/10 rounded-md p-6 sm:p-8 shadow-sm">
        <h1 className="font-display text-3xl mb-1">Vibe Tax Research</h1>
        <p className="text-ink/60 text-sm mb-6">Sign in to continue.</p>
        {resetOk && (
          <div className="mb-4 text-sm text-moss border border-moss/30 bg-moss/5 rounded p-3">
            Password reset successfully. Sign in with your new password.
          </div>
        )}
        <form onSubmit={onSubmit} className="space-y-4">
          <label className="block">
            <div className="text-xs uppercase tracking-wider text-ink/60 mb-1">Email</div>
            <input
              type="email"
              required
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              className="w-full px-3 py-2 border border-ink/20 rounded font-mono text-sm"
              autoComplete="email"
            />
          </label>
          <label className="block">
            <div className="text-xs uppercase tracking-wider text-ink/60 mb-1">Password</div>
            <input
              type="password"
              required
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              className="w-full px-3 py-2 border border-ink/20 rounded font-mono text-sm"
              autoComplete="current-password"
            />
          </label>
          {error && <div className="text-sm text-oxblood">{error}</div>}
          <button
            type="submit"
            disabled={busy}
            className="w-full py-2 bg-ink text-paper rounded font-display tracking-wide disabled:opacity-50"
          >
            {busy ? 'Signing in…' : 'Sign in'}
          </button>
        </form>
        <div className="mt-4 text-center">
          <Link to="/forgot" className="text-xs text-ink/60 hover:text-ink underline">
            Forgot password?
          </Link>
        </div>
      </div>
    </div>
  );
}
