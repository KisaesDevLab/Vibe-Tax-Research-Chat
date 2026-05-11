// Lands here from the email link with ?token=... in the URL. Two
// password fields (new + confirm) and on success the user is redirected
// to /login?reset=ok so the login page shows a success banner.
import { useState, useMemo, type FormEvent } from 'react';
import { Link, Navigate, useNavigate, useSearchParams } from 'react-router-dom';
import { api, ApiError } from '../lib/api';

export function ResetPasswordPage() {
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const token = useMemo(() => searchParams.get('token') ?? '', [searchParams]);
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (!token) return <Navigate to="/login" replace />;

  const tooShort = password.length > 0 && password.length < 8;
  const mismatch = confirm.length > 0 && password !== confirm;
  const canSubmit = password.length >= 8 && password === confirm && !busy;

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await api('/api/auth/reset-password', {
        method: 'POST',
        body: JSON.stringify({ token, new_password: password }),
        skipRefresh: true,
      });
      navigate('/login?reset=ok', { replace: true });
    } catch (err) {
      if (err instanceof ApiError && err.status === 400) {
        const body = err.body as { error?: string } | undefined;
        if (body?.error === 'invalid_or_expired_token') {
          setError(
            'This reset link is invalid or has expired. Request a new one from the Forgot password page.',
          );
        } else {
          setError('Password does not meet requirements (min 8 characters).');
        }
      } else if (err instanceof ApiError && err.status === 429) {
        setError('Too many attempts. Please wait an hour and try again.');
      } else {
        setError((err as Error).message ?? 'Something went wrong.');
      }
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="min-h-screen grid place-items-center bg-paper px-4 py-8">
      <div className="w-full max-w-[380px] bg-white border border-ink/10 rounded-md p-6 sm:p-8 shadow-sm">
        <h1 className="font-display text-2xl mb-1">Choose a new password</h1>
        <p className="text-ink/60 text-sm mb-6">
          At least 8 characters. After saving, you&apos;ll be signed out of every device.
        </p>
        <form onSubmit={onSubmit} className="space-y-4">
          <label className="block">
            <div className="text-xs uppercase tracking-wider text-ink/60 mb-1">New password</div>
            <input
              type="password"
              required
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              className="w-full px-3 py-2 border border-ink/20 rounded font-mono text-sm"
              autoComplete="new-password"
              minLength={8}
            />
            {tooShort && (
              <div className="text-xs text-oxblood mt-1">
                Password must be at least 8 characters.
              </div>
            )}
          </label>
          <label className="block">
            <div className="text-xs uppercase tracking-wider text-ink/60 mb-1">Confirm</div>
            <input
              type="password"
              required
              value={confirm}
              onChange={(e) => setConfirm(e.target.value)}
              className="w-full px-3 py-2 border border-ink/20 rounded font-mono text-sm"
              autoComplete="new-password"
            />
            {mismatch && <div className="text-xs text-oxblood mt-1">Passwords do not match.</div>}
          </label>
          {error && <div className="text-sm text-oxblood">{error}</div>}
          <button
            type="submit"
            disabled={!canSubmit}
            className="w-full py-2 bg-ink text-paper rounded font-display tracking-wide disabled:opacity-50"
          >
            {busy ? 'Saving…' : 'Reset password'}
          </button>
          <div className="text-center">
            <Link to="/login" className="text-xs text-ink/60 hover:text-ink underline">
              Cancel
            </Link>
          </div>
        </form>
      </div>
    </div>
  );
}
