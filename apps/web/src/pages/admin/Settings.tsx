// Phase 5 — settings page focused on the Anthropic API key.
import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { api } from '../../lib/api';

interface KeyStatus {
  configured: boolean;
  fingerprint?: string;
}

export function AdminSettingsPage() {
  const qc = useQueryClient();
  const [draft, setDraft] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const { data } = useQuery<KeyStatus>({
    queryKey: ['admin', 'settings', 'anthropic-key'],
    queryFn: () => api('/api/admin/settings/anthropic-key'),
  });

  const save = useMutation({
    mutationFn: () =>
      api('/api/admin/settings/anthropic-key', {
        method: 'POST',
        body: JSON.stringify({ api_key: draft, validate: true }),
      }),
    onSuccess: () => {
      setDraft('');
      qc.invalidateQueries({ queryKey: ['admin', 'settings', 'anthropic-key'] });
    },
  });

  const remove = useMutation({
    mutationFn: () => api('/api/admin/settings/anthropic-key', { method: 'DELETE' }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['admin', 'settings', 'anthropic-key'] }),
  });

  async function onSave() {
    setBusy(true);
    setError(null);
    try {
      await save.mutateAsync();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div>
      <h1 className="font-display text-3xl mb-6">Settings</h1>

      <section className="border border-ink/10 rounded p-6 bg-white max-w-2xl">
        <h2 className="font-display text-xl mb-2">Anthropic API key</h2>
        <p className="text-sm text-ink/60 mb-4">
          Encrypted at rest with AES-256-GCM, decrypted only at the moment of an API call. Never logged.
        </p>
        {data?.configured ? (
          <div className="mb-4">
            <span className="text-xs uppercase tracking-wider text-ink/50">Active key</span>
            <div className="font-mono text-sm">{data.fingerprint}</div>
          </div>
        ) : (
          <div className="mb-4 text-sm text-ink/60">No key configured.</div>
        )}
        <div className="flex gap-2">
          <input
            type="password"
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            placeholder="sk-ant-…"
            className="flex-1 px-3 py-2 border border-ink/20 rounded font-mono text-sm"
          />
          <button
            onClick={onSave}
            disabled={busy || !draft}
            className="px-3 py-2 bg-ink text-paper rounded text-sm disabled:opacity-50"
          >
            {busy ? 'Validating…' : data?.configured ? 'Rotate' : 'Save'}
          </button>
          {data?.configured && (
            <button
              onClick={() => remove.mutate()}
              className="px-3 py-2 border border-oxblood text-oxblood rounded text-sm"
            >
              Delete
            </button>
          )}
        </div>
        {error && <div className="text-oxblood text-sm mt-2">{error}</div>}
      </section>
    </div>
  );
}
