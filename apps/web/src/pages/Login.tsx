// Phase 3 — login page.
import { useState, type FormEvent } from 'react';
import { Navigate, useLocation } from 'react-router-dom';
import { useAuth } from '../components/AuthProvider';

export function LoginPage() {
  const { user, login } = useAuth();
  const location = useLocation();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  if (user) {
    const from = (location.state as { from?: { pathname: string } } | null)?.from?.pathname ?? '/chat';
    return <Navigate to={from} replace />;
  }

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
    <div className="min-h-screen grid place-items-center bg-paper">
      <div className="w-[380px] bg-white border border-ink/10 rounded-md p-8 shadow-sm">
        <h1 className="font-display text-3xl mb-1">Vibe Tax Research</h1>
        <p className="text-ink/60 text-sm mb-6">Sign in to continue.</p>
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
      </div>
    </div>
  );
}
