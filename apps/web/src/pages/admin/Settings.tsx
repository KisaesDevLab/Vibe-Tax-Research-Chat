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

      <PlanningModuleSection />
      <PlanReviewSection />
      <PlanMemosSection />
      <WebResourceStrategySection />
      <EmailSettingsSection />
      <AppBaseUrlSection />
    </div>
  );
}

// ── TP-0 — planning module toggle ──────────────────────────────────────
// Master switch for the Planning + Clients modules. Reads the effective
// value from /api/config (same source the shell uses) and writes through
// the dedicated admin endpoint.
function PlanningModuleSection() {
  const qc = useQueryClient();
  const { data } = useQuery<{ planning_enabled: boolean }>({
    queryKey: ['config'],
    queryFn: () => api('/api/config'),
  });

  const toggle = useMutation({
    mutationFn: (enabled: boolean) =>
      api('/api/admin/settings/planning-enabled', {
        method: 'POST',
        body: JSON.stringify({ enabled }),
      }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['config'] }),
  });

  const enabled = data?.planning_enabled ?? false;
  return (
    <section className="border border-ink/10 rounded p-6 bg-white max-w-2xl mt-6">
      <h2 className="font-display text-xl mb-2">Planning module</h2>
      <p className="text-sm text-ink/60 mb-4">
        Enables the Planning and Clients modules (client records, plan workflow, research archival).
        Off by default — the research app is unaffected while disabled.
      </p>
      <label className="flex items-center gap-3 text-sm">
        <input
          type="checkbox"
          checked={enabled}
          disabled={toggle.isPending}
          onChange={(e) => toggle.mutate(e.target.checked)}
        />
        <span>{enabled ? 'Enabled' : 'Disabled'}</span>
      </label>
    </section>
  );
}

// ── Plan memos (Claude-drafted) toggle ─────────────────────────────────
// Gates the "Draft memo (Claude)" action on the plan review screen. The
// server returns 403 memos_disabled when off.
function PlanMemosSection() {
  const qc = useQueryClient();
  const [error, setError] = useState<string | null>(null);
  const { data } = useQuery<{ enabled: boolean }>({
    queryKey: ['admin', 'settings', 'plan-memos-enabled'],
    queryFn: () => api('/api/admin/settings/plan-memos-enabled'),
  });

  const toggle = useMutation({
    mutationFn: (enabled: boolean) =>
      api('/api/admin/settings/plan-memos-enabled', {
        method: 'PUT',
        body: JSON.stringify({ enabled }),
      }),
    onSuccess: () => {
      setError(null);
      qc.invalidateQueries({ queryKey: ['admin', 'settings', 'plan-memos-enabled'] });
    },
    onError: (err) => setError((err as Error).message),
  });

  const enabled = data?.enabled ?? false;
  return (
    <section className="border border-ink/10 rounded p-6 bg-white max-w-2xl mt-6">
      <h2 className="font-display text-xl mb-2">Plan memos (Claude)</h2>
      <p className="text-sm text-ink/60 mb-4">
        Lets staff draft a plan memo with Claude from the review screen once a plan is in review.
        Each draft is an Anthropic API call billed to the configured key.
      </p>
      <label className="flex items-center gap-3 text-sm">
        <input
          type="checkbox"
          checked={enabled}
          disabled={toggle.isPending}
          onChange={(e) => toggle.mutate(e.target.checked)}
        />
        <span>{enabled ? 'Enabled' : 'Disabled'}</span>
      </label>
      {error && <div className="text-oxblood text-sm mt-2">{error}</div>}
    </section>
  );
}

// ── Partner-review requirement toggle ──────────────────────────────────
// Off (the default) lets a plan go straight draft → presented. On restores
// the four-eyes gate: assigned reviewer, full checklist, and the
// elevated-risk research-link requirement.
function PlanReviewSection() {
  const qc = useQueryClient();
  const [error, setError] = useState<string | null>(null);
  const { data } = useQuery<{ enabled: boolean }>({
    queryKey: ['admin', 'settings', 'plan-review-required'],
    queryFn: () => api('/api/admin/settings/plan-review-required'),
  });

  const toggle = useMutation({
    mutationFn: (enabled: boolean) =>
      api('/api/admin/settings/plan-review-required', {
        method: 'PUT',
        body: JSON.stringify({ enabled }),
      }),
    onSuccess: () => {
      setError(null);
      qc.invalidateQueries({ queryKey: ['admin', 'settings', 'plan-review-required'] });
    },
    onError: (err) => setError((err as Error).message),
  });

  const enabled = data?.enabled ?? false;
  return (
    <section className="border border-ink/10 rounded p-6 bg-white max-w-2xl mt-6">
      <h2 className="font-display text-xl mb-2">Require partner review</h2>
      <p className="text-sm text-ink/60 mb-4">
        When on, a plan can only reach “presented” through in-review: a reviewing partner other than
        the preparer must be assigned, every strategy checklist item ticked, and each elevated-risk
        strategy backed by a linked research archive. When off, staff can present a plan straight
        from draft and the checklist stays available as an optional working aid.
      </p>
      <label className="flex items-center gap-3 text-sm">
        <input
          type="checkbox"
          checked={enabled}
          disabled={toggle.isPending}
          onChange={(e) => toggle.mutate(e.target.checked)}
        />
        <span>{enabled ? 'Review required' : 'Review optional'}</span>
      </label>
      {error && <div className="text-oxblood text-sm mt-2">{error}</div>}
    </section>
  );
}

// ── Email settings (SMTP / Resend) ─────────────────────────────────────
// Mirrors the Anthropic-key card: GET shows the current configured state
// (provider, from-address, fingerprint of the secret); Save accepts a
// draft and validates it via the server's transport.verify() call before
// persisting. A separate "Send test email" button covers DNS/SPF/from-
// address issues that verify() can't catch.

type EmailProviderKind = 'smtp' | 'resend';

interface EmailSettingsResponse {
  configured: boolean;
  provider?: EmailProviderKind;
  from_address?: string;
  from_name?: string;
  smtp?: { host: string; port: number; secure: boolean; user: string };
  has_secret?: boolean;
  fingerprint?: string;
}

function EmailSettingsSection() {
  const qc = useQueryClient();
  const { data } = useQuery<EmailSettingsResponse>({
    queryKey: ['admin', 'settings', 'email'],
    queryFn: () => api('/api/admin/settings/email'),
  });

  const [provider, setProvider] = useState<EmailProviderKind>('smtp');
  const [fromAddress, setFromAddress] = useState('');
  const [fromName, setFromName] = useState('');
  const [host, setHost] = useState('');
  const [port, setPort] = useState<number>(587);
  const [secure, setSecure] = useState(false);
  const [user, setUser] = useState('');
  const [password, setPassword] = useState('');
  const [resendApiKey, setResendApiKey] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [testStatus, setTestStatus] = useState<{ ok: boolean; msg: string } | null>(null);

  // Hydrate the form once the GET resolves. Only re-hydrate when the
  // *server* state changes (data identity), not on every keystroke.
  useEffect(() => {
    if (!data || !data.configured) return;
    setProvider(data.provider ?? 'smtp');
    setFromAddress(data.from_address ?? '');
    setFromName(data.from_name ?? '');
    if (data.smtp) {
      setHost(data.smtp.host);
      setPort(data.smtp.port);
      setSecure(data.smtp.secure);
      setUser(data.smtp.user);
    }
    // Password / api_key intentionally NOT hydrated — server doesn't
    // return them, and an empty field signals "keep the existing secret".
  }, [data]);

  const save = useMutation({
    mutationFn: async () => {
      const body: Record<string, unknown> = {
        provider,
        from_address: fromAddress,
        from_name: fromName,
        validate: true,
      };
      if (provider === 'smtp') {
        body.smtp = { host, port, secure, user };
        if (password) body.password = password;
      } else {
        if (resendApiKey) body.resend_api_key = resendApiKey;
      }
      return api('/api/admin/settings/email', {
        method: 'POST',
        body: JSON.stringify(body),
      });
    },
    onSuccess: () => {
      setPassword('');
      setResendApiKey('');
      setTestStatus(null);
      qc.invalidateQueries({ queryKey: ['admin', 'settings', 'email'] });
    },
  });

  const remove = useMutation({
    mutationFn: () => api('/api/admin/settings/email', { method: 'DELETE' }),
    onSuccess: () => {
      setTestStatus(null);
      qc.invalidateQueries({ queryKey: ['admin', 'settings', 'email'] });
    },
  });

  const sendTest = useMutation({
    mutationFn: () =>
      api<{ ok: true; sent_to: string }>('/api/admin/settings/email/send-test', {
        method: 'POST',
      }),
    onSuccess: (r) => setTestStatus({ ok: true, msg: `Test email sent to ${r.sent_to}` }),
    onError: (e) => setTestStatus({ ok: false, msg: (e as Error).message }),
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

  const needsSecret = !data?.has_secret;
  const buttonLabel = busy ? 'Validating…' : data?.configured ? 'Rotate' : 'Save';

  return (
    <section className="border border-ink/10 rounded p-6 bg-white max-w-2xl mt-6">
      <h2 className="font-display text-xl mb-2">Email (password reset)</h2>
      <p className="text-sm text-ink/60 mb-4">
        Configure an outbound email transport so users can reset their own passwords. SMTP works
        with any provider the firm already uses (Office&nbsp;365, Google Workspace, or a relay);
        Resend is a transactional-email API. The password / API key is encrypted at rest with
        AES-256-GCM.
      </p>

      {data?.configured && (
        <div className="mb-4 grid grid-cols-2 gap-x-4 gap-y-1 text-sm">
          <span className="text-ink/50">Provider</span>
          <span className="font-mono">{data.provider}</span>
          <span className="text-ink/50">From</span>
          <span className="font-mono truncate">
            {data.from_name ? `${data.from_name} <${data.from_address}>` : data.from_address}
          </span>
          {data.smtp && (
            <>
              <span className="text-ink/50">Host</span>
              <span className="font-mono truncate">
                {data.smtp.host}:{data.smtp.port} {data.smtp.secure ? '(TLS)' : '(STARTTLS)'}
              </span>
              <span className="text-ink/50">User</span>
              <span className="font-mono truncate">{data.smtp.user}</span>
            </>
          )}
          <span className="text-ink/50">Secret</span>
          <span className="font-mono">{data.fingerprint ?? '—'}</span>
        </div>
      )}

      <div className="mb-3">
        <div className="text-xs uppercase tracking-wider text-ink/60 mb-1">Provider</div>
        <div className="inline-flex border border-ink/20 rounded overflow-hidden text-xs">
          <button
            type="button"
            onClick={() => setProvider('smtp')}
            className={`px-3 py-1 ${provider === 'smtp' ? 'bg-ink text-paper' : 'bg-white'}`}
          >
            SMTP
          </button>
          <button
            type="button"
            onClick={() => setProvider('resend')}
            className={`px-3 py-1 ${provider === 'resend' ? 'bg-ink text-paper' : 'bg-white'}`}
          >
            Resend
          </button>
        </div>
      </div>

      <div className="grid grid-cols-2 gap-3 mb-3">
        <label className="block col-span-2">
          <div className="text-xs uppercase tracking-wider text-ink/60 mb-1">From address</div>
          <input
            type="email"
            value={fromAddress}
            onChange={(e) => setFromAddress(e.target.value)}
            placeholder="no-reply@firm.example"
            className="w-full px-3 py-2 border border-ink/20 rounded font-mono text-sm"
          />
        </label>
        <label className="block col-span-2">
          <div className="text-xs uppercase tracking-wider text-ink/60 mb-1">From name</div>
          <input
            type="text"
            value={fromName}
            onChange={(e) => setFromName(e.target.value)}
            placeholder="Vibe Tax Research"
            className="w-full px-3 py-2 border border-ink/20 rounded text-sm"
          />
        </label>
      </div>

      {provider === 'smtp' && (
        <div className="grid grid-cols-2 gap-3 mb-3">
          <label className="block">
            <div className="text-xs uppercase tracking-wider text-ink/60 mb-1">Host</div>
            <input
              type="text"
              value={host}
              onChange={(e) => setHost(e.target.value)}
              placeholder="smtp.office365.com"
              className="w-full px-3 py-2 border border-ink/20 rounded font-mono text-sm"
            />
          </label>
          <label className="block">
            <div className="text-xs uppercase tracking-wider text-ink/60 mb-1">Port</div>
            <input
              type="number"
              value={port}
              onChange={(e) => setPort(Number(e.target.value) || 0)}
              className="w-full px-3 py-2 border border-ink/20 rounded font-mono text-sm"
            />
          </label>
          <label className="block col-span-2">
            <div className="text-xs uppercase tracking-wider text-ink/60 mb-1">User</div>
            <input
              type="text"
              value={user}
              onChange={(e) => setUser(e.target.value)}
              placeholder="user@firm.example"
              className="w-full px-3 py-2 border border-ink/20 rounded font-mono text-sm"
            />
          </label>
          <label className="block col-span-2">
            <div className="text-xs uppercase tracking-wider text-ink/60 mb-1">
              Password{' '}
              {data?.has_secret && <span className="text-ink/40">(leave blank to keep)</span>}
            </div>
            <input
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder={data?.has_secret ? '••••••' : 'app password or SMTP credential'}
              className="w-full px-3 py-2 border border-ink/20 rounded font-mono text-sm"
            />
          </label>
          <label className="col-span-2 inline-flex items-center gap-2 text-sm text-ink/70">
            <input
              type="checkbox"
              checked={secure}
              onChange={(e) => setSecure(e.target.checked)}
              className="rounded"
            />
            <span>
              Use TLS on connect (port 465). Leave off for STARTTLS on 587 — the usual choice for
              Office 365 / Google Workspace.
            </span>
          </label>
        </div>
      )}

      {provider === 'resend' && (
        <label className="block mb-3">
          <div className="text-xs uppercase tracking-wider text-ink/60 mb-1">
            Resend API key{' '}
            {data?.has_secret && <span className="text-ink/40">(leave blank to keep)</span>}
          </div>
          <input
            type="password"
            value={resendApiKey}
            onChange={(e) => setResendApiKey(e.target.value)}
            placeholder={data?.has_secret ? '••••••' : 're_…'}
            className="w-full px-3 py-2 border border-ink/20 rounded font-mono text-sm"
          />
        </label>
      )}

      <div className="flex flex-wrap gap-2">
        <button
          onClick={onSave}
          disabled={
            busy ||
            !fromAddress ||
            !fromName ||
            (provider === 'smtp' && (!host || !port || !user)) ||
            // Need a secret on first save; ok to leave blank on re-save.
            (needsSecret && provider === 'smtp' && !password) ||
            (needsSecret && provider === 'resend' && !resendApiKey)
          }
          className="px-3 py-2 bg-ink text-paper rounded text-sm disabled:opacity-50"
        >
          {buttonLabel}
        </button>
        {data?.configured && (
          <>
            <button
              onClick={() => sendTest.mutate()}
              disabled={sendTest.isPending}
              className="px-3 py-2 border border-ink/30 rounded text-sm disabled:opacity-50"
            >
              {sendTest.isPending ? 'Sending…' : 'Send test email'}
            </button>
            <button
              onClick={() => remove.mutate()}
              className="px-3 py-2 border border-oxblood text-oxblood rounded text-sm"
            >
              Delete
            </button>
          </>
        )}
      </div>
      {error && <div className="text-oxblood text-sm mt-2">{error}</div>}
      {testStatus && (
        <div className={`text-sm mt-2 ${testStatus.ok ? 'text-moss' : 'text-oxblood'}`}>
          {testStatus.msg}
        </div>
      )}
    </section>
  );
}

// ── App base URL (for password-reset links) ────────────────────────────
// Reset emails embed an absolute URL like https://<host>/reset?token=… so
// the worker needs to know what to put in front of /reset. Kept separate
// from email settings because it changes for unrelated reasons (DNS,
// reverse-proxy path).

function AppBaseUrlSection() {
  const qc = useQueryClient();
  const { data } = useQuery<{ url: string }>({
    queryKey: ['admin', 'settings', 'app-base-url'],
    queryFn: () => api('/api/admin/settings/app-base-url'),
  });
  const [draft, setDraft] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [savedAt, setSavedAt] = useState<number | null>(null);

  useEffect(() => {
    setDraft(data?.url ?? '');
  }, [data]);

  const save = useMutation({
    mutationFn: () =>
      api('/api/admin/settings/app-base-url', {
        method: 'POST',
        body: JSON.stringify({ url: draft }),
      }),
    onSuccess: () => {
      setError(null);
      setSavedAt(Date.now());
      qc.invalidateQueries({ queryKey: ['admin', 'settings', 'app-base-url'] });
    },
    onError: (e) => setError((e as Error).message),
  });

  const dirty = draft !== (data?.url ?? '');

  return (
    <section className="border border-ink/10 rounded p-6 bg-white max-w-2xl mt-6">
      <h2 className="font-display text-xl mb-2">App base URL</h2>
      <p className="text-sm text-ink/60 mb-4">
        Public URL used to build password-reset links (e.g.,{' '}
        <code>https://192.168.1.79/vibe-tax-research</code>). The worker appends{' '}
        <code>/reset?token=…</code>. Leave blank to disable reset emails.
      </p>
      <div className="flex gap-2">
        <input
          type="url"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          placeholder="https://your-appliance.example"
          className="flex-1 px-3 py-2 border border-ink/20 rounded font-mono text-sm"
        />
        <button
          onClick={() => save.mutate()}
          disabled={!dirty || save.isPending}
          className="px-3 py-2 bg-ink text-paper rounded text-sm disabled:opacity-50"
        >
          {save.isPending ? 'Saving…' : 'Save'}
        </button>
      </div>
      {error && <div className="text-oxblood text-sm mt-2">{error}</div>}
      {savedAt && !error && <div className="text-moss text-sm mt-2">Saved.</div>}
    </section>
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
