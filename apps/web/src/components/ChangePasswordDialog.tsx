// Self-service password change for a logged-in user. Requires the current
// password (a stolen session must not be enough to take over the account);
// the server revokes every OTHER session on success, keeping this one alive
// by passing our own refresh token.
import { useState } from 'react';
import { api, ApiError } from '../lib/api';
import { tokenStore } from '../lib/token-store';

export function ChangePasswordDialog({ onClose }: { onClose: () => void }) {
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [confirm, setConfirm] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    if (next.length < 8) {
      setError('New password must be at least 8 characters.');
      return;
    }
    if (next !== confirm) {
      setError('New password and confirmation do not match.');
      return;
    }
    setBusy(true);
    try {
      await api('/api/auth/change-password', {
        method: 'POST',
        body: JSON.stringify({
          current_password: current,
          new_password: next,
          refresh_token: tokenStore.getRefresh() ?? undefined,
        }),
      });
      setDone(true);
    } catch (err) {
      if (err instanceof ApiError && err.message === 'invalid_current_password') {
        setError('Current password is incorrect.');
      } else {
        setError((err as Error).message);
      }
    } finally {
      setBusy(false);
    }
  }

  return (
    <div
      className="fixed inset-0 z-40 bg-ink/30 grid place-items-center p-4"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="bg-white rounded shadow-xl p-6 w-full max-w-md">
        {done ? (
          <>
            <h2 className="font-display text-xl mb-2">Password changed</h2>
            <p className="text-sm text-ink/60 mb-4">
              Your other signed-in sessions have been logged out. This one stays active.
            </p>
            <div className="flex justify-end">
              <button onClick={onClose} className="px-3 py-1.5 bg-ink text-paper rounded text-sm">
                Done
              </button>
            </div>
          </>
        ) : (
          <form onSubmit={(e) => void submit(e)}>
            <h2 className="font-display text-xl mb-4">Change password</h2>
            <label className="block text-xs uppercase tracking-wider text-ink/50 mb-1">
              Current password
            </label>
            <input
              type="password"
              autoComplete="current-password"
              value={current}
              onChange={(e) => setCurrent(e.target.value)}
              className="w-full border border-ink/20 rounded px-3 py-2 text-sm mb-3"
              required
            />
            <label className="block text-xs uppercase tracking-wider text-ink/50 mb-1">
              New password
            </label>
            <input
              type="password"
              autoComplete="new-password"
              value={next}
              onChange={(e) => setNext(e.target.value)}
              className="w-full border border-ink/20 rounded px-3 py-2 text-sm mb-3"
              placeholder="At least 8 characters"
              required
            />
            <label className="block text-xs uppercase tracking-wider text-ink/50 mb-1">
              Confirm new password
            </label>
            <input
              type="password"
              autoComplete="new-password"
              value={confirm}
              onChange={(e) => setConfirm(e.target.value)}
              className="w-full border border-ink/20 rounded px-3 py-2 text-sm mb-4"
              required
            />
            {error && (
              <div className="border border-oxblood/40 bg-oxblood/5 text-oxblood text-xs rounded p-2 mb-3">
                {error}
              </div>
            )}
            <div className="flex justify-end gap-2">
              <button type="button" onClick={onClose} className="px-3 py-1.5 text-sm">
                Cancel
              </button>
              <button
                type="submit"
                disabled={busy}
                className="px-3 py-1.5 bg-ink text-paper rounded text-sm disabled:opacity-50"
              >
                {busy ? 'Changing…' : 'Change password'}
              </button>
            </div>
          </form>
        )}
      </div>
    </div>
  );
}
