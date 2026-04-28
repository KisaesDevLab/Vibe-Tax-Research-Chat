// Phase 28 — first-run wizard. Three steps: admin, key, default model + skills sync trigger.
import { useEffect, useState } from 'react';
import { Navigate } from 'react-router-dom';
import { api } from '../lib/api';
import { tokenStore } from '../lib/token-store';
import type { AuthUser } from '@vibe/shared';

type Step = 'admin' | 'key' | 'model' | 'done';

interface BootstrapResponse {
  ok: true;
  access_token: string;
  refresh_token: string;
  user: AuthUser;
}

export function SetupPage() {
  const [step, setStep] = useState<Step>('admin');
  const [adminEmail, setAdminEmail] = useState('');
  const [adminPassword, setAdminPassword] = useState('');
  const [apiKey, setApiKey] = useState('');
  const [defaultModel, setDefaultModel] = useState('claude-sonnet-4-6');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  // If an admin already exists, the wizard is closed — bootstrap would 409.
  // Send the visitor back to /login so they don't fight a form that can't succeed.
  const [alreadyBootstrapped, setAlreadyBootstrapped] = useState(false);
  useEffect(() => {
    let cancelled = false;
    api<{ admin_exists: boolean }>('/api/setup/status', { skipRefresh: true })
      .then((r) => {
        if (!cancelled && r.admin_exists) setAlreadyBootstrapped(true);
      })
      .catch(() => {
        // Network/API down — let the user try and surface real errors below.
      });
    return () => {
      cancelled = true;
    };
  }, []);

  if (alreadyBootstrapped) return <Navigate to="/login" replace />;
  if (step === 'done') return <Navigate to="/chat" replace />;

  async function next() {
    setError(null);
    setBusy(true);
    try {
      if (step === 'admin') {
        // Bootstraps the first admin AND issues access+refresh tokens we can
        // use for the next two steps without a separate login.
        const r = await api<BootstrapResponse>('/api/setup/bootstrap', {
          method: 'POST',
          body: JSON.stringify({ email: adminEmail, password: adminPassword }),
          skipRefresh: true,
        });
        tokenStore.set(r.access_token, r.refresh_token);
        setStep('key');
      } else if (step === 'key') {
        await api('/api/admin/settings/anthropic-key', {
          method: 'POST',
          body: JSON.stringify({ api_key: apiKey, validate: true }),
        });
        setStep('model');
      } else if (step === 'model') {
        await api('/api/admin/settings/default-model', {
          method: 'POST',
          body: JSON.stringify({ model_id: defaultModel }),
        });
        // Skills sync is best-effort here — it's a long-running job and the
        // wizard should not block on it. If the sync queue isn't ready yet,
        // surface the message rather than silently swallowing.
        try {
          await api('/api/admin/skills/sync', { method: 'POST' });
        } catch (err) {
          console.warn('initial skills sync deferred:', (err as Error).message);
        }
        setStep('done');
      }
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="min-h-screen grid place-items-center bg-paper">
      <div className="bg-white border border-ink/10 rounded p-8 w-[480px]">
        <h1 className="font-display text-2xl mb-2">First-run setup</h1>
        <p className="text-ink/60 text-sm mb-6">Three steps. Should take under five minutes.</p>

        {step === 'admin' && (
          <div className="space-y-3">
            <input
              placeholder="admin email"
              value={adminEmail}
              onChange={(e) => setAdminEmail(e.target.value)}
              className="w-full px-3 py-2 border border-ink/20 rounded font-mono text-sm"
              autoComplete="email"
            />
            <input
              type="password"
              placeholder="admin password"
              value={adminPassword}
              onChange={(e) => setAdminPassword(e.target.value)}
              className="w-full px-3 py-2 border border-ink/20 rounded font-mono text-sm"
              autoComplete="new-password"
            />
          </div>
        )}
        {step === 'key' && (
          <div>
            <label className="block text-xs uppercase tracking-wider text-ink/50 mb-1">
              Anthropic API key
            </label>
            <input
              type="password"
              value={apiKey}
              onChange={(e) => setApiKey(e.target.value)}
              placeholder="sk-ant-…"
              className="w-full px-3 py-2 border border-ink/20 rounded font-mono text-sm"
              autoComplete="off"
            />
            <p className="text-xs text-ink/50 mt-1">
              Validated with a 1-token Haiku call. Stored AES-256-GCM.
            </p>
          </div>
        )}
        {step === 'model' && (
          <div>
            <label className="block text-xs uppercase tracking-wider text-ink/50 mb-1">
              Default model
            </label>
            <select
              value={defaultModel}
              onChange={(e) => setDefaultModel(e.target.value)}
              className="w-full px-3 py-2 border border-ink/20 rounded text-sm"
            >
              <option value="claude-sonnet-4-6">Claude Sonnet 4.6 (recommended)</option>
              <option value="claude-opus-4-7">Claude Opus 4.7</option>
              <option value="claude-opus-4-6">Claude Opus 4.6</option>
              <option value="claude-haiku-4-5">Claude Haiku 4.5</option>
            </select>
            <p className="text-xs text-ink/50 mt-1">
              Skills sync will run after you finish this step.
            </p>
          </div>
        )}

        {error && <div className="text-oxblood text-sm mt-3">{error}</div>}
        <button
          onClick={next}
          disabled={busy}
          className="mt-6 w-full bg-ink text-paper py-2 rounded font-display tracking-wide disabled:opacity-50"
        >
          {busy ? 'Working…' : step === 'model' ? 'Finish' : 'Next'}
        </button>
      </div>
    </div>
  );
}
