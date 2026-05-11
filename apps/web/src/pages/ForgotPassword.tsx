// Public "Forgot password?" entry point. Anti-enumeration: the success
// screen renders the same text regardless of whether the email matched a
// user, and we never report failure to the visitor — only the rate limit
// (429) and malformed input are surfaced separately.
import { useState, type FormEvent } from 'react';
import { Link } from 'react-router-dom';
import { api, ApiError } from '../lib/api';

export function ForgotPasswordPage() {
  const [email, setEmail] = useState('');
  const [submitted, setSubmitted] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await api('/api/auth/forgot-password', {
        method: 'POST',
        body: JSON.stringify({ email }),
        skipRefresh: true,
      });
      setSubmitted(true);
    } catch (err) {
      // Anti-enumeration: even on a network error, show the same
      // confirmation so the response shape doesn't leak info. The
      // exceptions are 429 (rate limit) and 400 (malformed input) —
      // those are operational, not enumeration vectors.
      if (err instanceof ApiError && err.status === 429) {
        setError('Too many requests. Please wait an hour and try again.');
      } else if (err instanceof ApiError && err.status === 400) {
        setError('Please enter a valid email address.');
      } else {
        setSubmitted(true);
      }
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="min-h-screen grid place-items-center bg-paper px-4 py-8">
      <div className="w-full max-w-[380px] bg-white border border-ink/10 rounded-md p-6 sm:p-8 shadow-sm">
        <h1 className="font-display text-2xl mb-1">Reset password</h1>
        <p className="text-ink/60 text-sm mb-6">
          Enter your email and we&apos;ll send you a reset link. The link expires in one hour and
          can only be used once.
        </p>

        {submitted ? (
          <div className="space-y-4">
            <div className="text-sm text-moss border border-moss/30 bg-moss/5 rounded p-3">
              If that email is registered, a password-reset link is on its way. Check your inbox
              (and spam folder).
            </div>
            <Link
              to="/login"
              className="block text-center py-2 bg-ink text-paper rounded font-display tracking-wide"
            >
              Back to sign in
            </Link>
          </div>
        ) : (
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
            {error && <div className="text-sm text-oxblood">{error}</div>}
            <button
              type="submit"
              disabled={busy}
              className="w-full py-2 bg-ink text-paper rounded font-display tracking-wide disabled:opacity-50"
            >
              {busy ? 'Sending…' : 'Send reset link'}
            </button>
            <div className="text-center">
              <Link to="/login" className="text-xs text-ink/60 hover:text-ink underline">
                Back to sign in
              </Link>
            </div>
          </form>
        )}
      </div>
    </div>
  );
}
