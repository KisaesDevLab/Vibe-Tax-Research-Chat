// Phase 5 + 36 — settings page: Anthropic API key + per-source web
// resource strategy.
import { useState, useEffect } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { api } from '../../lib/api';

interface KeyStatus {
  configured: boolean;
  fingerprint?: string;
}

type WebResourceMode = 'anthropic' | 'mcp';
type WebResourceSource = 'usc' | 'cfr' | 'irb' | 'fr' | 'dawson' | 'govinfo' | 'state_dor';
interface StrategyResponse {
  strategy: Record<WebResourceSource, WebResourceMode>;
  implemented: WebResourceSource[];
  sources: WebResourceSource[];
}

const SOURCE_LABELS: Record<WebResourceSource, string> = {
  usc: 'U.S. Code (uscode.house.gov)',
  cfr: 'CFR (ecfr.gov)',
  irb: 'IRS Bulletin',
  fr: 'Federal Register (IRS rules)',
  dawson: 'U.S. Tax Court (DAWSON)',
  govinfo: 'GovInfo (Public Laws)',
  state_dor: 'State DORs (top 10)',
};

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
          Encrypted at rest with AES-256-GCM, decrypted only at the moment of an API call. Never
          logged.
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

      <WebResourceStrategySection />
    </div>
  );
}

// Per-source toggle between Anthropic web tools (v1 default) and the
// appliance-side authority-mcp service (v1.5). Sources whose authority-
// mcp impl is still a stub are visible but their `mcp` option is locked
// — the server enforces the same constraint, so this is just UX.
function WebResourceStrategySection() {
  const qc = useQueryClient();
  const { data, isLoading } = useQuery<StrategyResponse>({
    queryKey: ['admin', 'settings', 'web-resource-strategy'],
    queryFn: () => api('/api/admin/settings/web-resource-strategy'),
  });

  const [draft, setDraft] = useState<Record<WebResourceSource, WebResourceMode> | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (data && !draft) setDraft(data.strategy);
  }, [data, draft]);

  const save = useMutation({
    mutationFn: (next: Record<WebResourceSource, WebResourceMode>) =>
      api('/api/admin/settings/web-resource-strategy', {
        method: 'PUT',
        body: JSON.stringify({ strategy: next }),
      }),
    onSuccess: () => {
      setError(null);
      qc.invalidateQueries({ queryKey: ['admin', 'settings', 'web-resource-strategy'] });
    },
    onError: (e) => setError(e instanceof Error ? e.message : String(e)),
  });

  if (isLoading || !data || !draft) {
    return (
      <section className="border border-ink/10 rounded p-6 bg-white max-w-3xl mt-6">
        <h2 className="font-display text-xl mb-2">Web resource strategy</h2>
        <div className="text-sm text-ink/60">Loading…</div>
      </section>
    );
  }

  const dirty = JSON.stringify(draft) !== JSON.stringify(data.strategy);
  const implementedSet = new Set(data.implemented);

  return (
    <section className="border border-ink/10 rounded p-6 bg-white max-w-3xl mt-6">
      <h2 className="font-display text-xl mb-2">Web resource strategy</h2>
      <p className="text-sm text-ink/60 mb-4">
        For each authoritative source, choose whether Claude consults it via Anthropic's{' '}
        <code>web_fetch</code> (v1 default) or the appliance-side <code>authority-mcp</code> cache
        (v1.5). The MCP path keeps source bytes inside your hardware and serves cached lookups in
        under 100&nbsp;ms.
      </p>
      <div className="space-y-2">
        {data.sources.map((src) => {
          const mode = draft[src];
          const canUseMcp = implementedSet.has(src);
          return (
            <div
              key={src}
              className="flex items-center justify-between border-b border-ink/5 py-2 last:border-0"
            >
              <div>
                <div className="font-medium text-sm">{SOURCE_LABELS[src]}</div>
                <div className="text-xs text-ink/50">
                  {canUseMcp
                    ? 'authority-mcp implemented'
                    : 'authority-mcp stub — keep on anthropic'}
                </div>
              </div>
              <div className="inline-flex border border-ink/20 rounded overflow-hidden text-xs">
                <button
                  type="button"
                  onClick={() => setDraft({ ...draft, [src]: 'anthropic' })}
                  className={`px-3 py-1 ${mode === 'anthropic' ? 'bg-ink text-paper' : 'bg-white'}`}
                >
                  Anthropic
                </button>
                <button
                  type="button"
                  disabled={!canUseMcp}
                  onClick={() => canUseMcp && setDraft({ ...draft, [src]: 'mcp' })}
                  className={`px-3 py-1 ${
                    mode === 'mcp' ? 'bg-ink text-paper' : 'bg-white'
                  } ${canUseMcp ? '' : 'opacity-30 cursor-not-allowed'}`}
                >
                  MCP
                </button>
              </div>
            </div>
          );
        })}
      </div>
      <div className="flex items-center gap-3 mt-4">
        <button
          type="button"
          disabled={!dirty || save.isPending}
          onClick={() => save.mutate(draft)}
          className="px-3 py-1.5 bg-ink text-paper rounded text-sm disabled:opacity-50"
        >
          {save.isPending ? 'Saving…' : 'Save'}
        </button>
        {dirty && (
          <button
            type="button"
            onClick={() => setDraft(data.strategy)}
            className="text-xs underline text-ink/60"
          >
            Discard
          </button>
        )}
        {error && <span className="text-sm text-rose-700">{error}</span>}
      </div>
      <p className="text-xs text-ink/50 mt-3">
        Note: in v1.5 the MCP toggle records your choice but the chat tool-use loop that honors it
        ships in a follow-up. Until then, all sources behave as <code>anthropic</code> at chat time
        regardless of this setting.
      </p>
    </section>
  );
}
