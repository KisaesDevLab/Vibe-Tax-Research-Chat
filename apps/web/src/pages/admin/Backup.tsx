// Admin → Backup & restore. Moves an entire install to another server
// without anyone opening a shell.
//
// The archive is downloaded straight from the response stream rather than
// buffered into a blob URL where practical — but the browser needs the
// whole body before it can hand over a file, so the passphrase gate and
// the "this may take a while" messaging matter more than usual here.
import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { api, apiFetch } from '../../lib/api';

interface BackupStatus {
  appVersion: string;
  database: string;
  pgTools: string | null;
  toolError: string | null;
  includes: Record<string, boolean>;
  masterKeyFingerprint: string;
  minPassphrase: number;
}

type RestoreState =
  | { status: 'idle' }
  | { status: 'running'; startedAt: string; step: string }
  | { status: 'succeeded'; finishedAt: string; result: RestoreResult }
  | { status: 'failed'; finishedAt: string; error: string; code: string; harmless: boolean };

interface RestoreResult {
  ok: true;
  restored: {
    createdAt: string | null;
    appVersion: string | null;
    files: number;
    database: string | null;
  };
  masterKey: { matches: boolean; action: string | null; keyFromArchive: string | null };
  restartRequired: boolean;
}

export function AdminBackupPage() {
  const qc = useQueryClient();
  const { data: status } = useQuery<BackupStatus>({
    queryKey: ['admin', 'backup', 'status'],
    queryFn: () => api('/api/admin/backup/status'),
  });

  const [passphrase, setPassphrase] = useState('');
  const [confirmPass, setConfirmPass] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);

  const [file, setFile] = useState<File | null>(null);
  const [restorePass, setRestorePass] = useState('');
  const [restoreTyped, setRestoreTyped] = useState('');
  const [restoring, setRestoring] = useState(false);

  // The restore runs server-side, detached from the request that started
  // it — a reverse proxy will not hold a connection open for minutes, and
  // a request killed mid-restore is what corrupts a database. Poll while
  // one is running.
  const { data: restoreState } = useQuery<RestoreState>({
    queryKey: ['admin', 'backup', 'restore-status'],
    queryFn: () => api('/api/admin/backup/restore/status'),
    refetchInterval: (q) => (q.state.data?.status === 'running' ? 2000 : false),
  });
  const running = restoreState?.status === 'running' || restoring;
  const restoreResult = restoreState?.status === 'succeeded' ? restoreState.result : null;

  const minLen = status?.minPassphrase ?? 12;
  const passOk = passphrase.length >= minLen && passphrase === confirmPass;

  async function createBackup() {
    setBusy(true);
    setError(null);
    setNote(null);
    try {
      const res = await apiFetch('/api/admin/backup', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ passphrase }),
      });
      const blob = await res.blob();
      const cd = res.headers.get('content-disposition') ?? '';
      const name = /filename="([^"]+)"/.exec(cd)?.[1] ?? 'vibe-tax-backup.vtbk';
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = name;
      a.click();
      URL.revokeObjectURL(url);
      setNote(
        `Downloaded ${name} (${(blob.size / 1024 / 1024).toFixed(1)} MB). Keep the passphrase safe — the archive cannot be opened without it.`,
      );
      setPassphrase('');
      setConfirmPass('');
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  async function clearStatus() {
    try {
      await apiFetch('/api/admin/backup/restore/reset', { method: 'POST' });
      await qc.invalidateQueries({ queryKey: ['admin', 'backup', 'restore-status'] });
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  async function runRestore() {
    if (!file) return;
    setRestoring(true);
    setError(null);
    try {
      const form = new FormData();
      form.append('file', file);
      form.append('passphrase', restorePass);
      form.append('confirm', 'replace-all-data');
      // Returns 202 as soon as the upload lands; the outcome arrives via
      // the status poll below.
      await apiFetch('/api/admin/backup/restore', { method: 'POST', body: form });
      await qc.invalidateQueries({ queryKey: ['admin', 'backup', 'restore-status'] });
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setRestoring(false);
    }
  }

  return (
    <div className="max-w-2xl space-y-6">
      <div>
        <h1 className="font-display text-2xl mb-1">Backup &amp; restore</h1>
        <p className="text-sm text-ink/60">
          A backup is one encrypted file holding the database, uploaded documents, rendered
          deliverables, the skills workspace, and the master key. Restoring it on another server
          reproduces this install completely.
        </p>
      </div>

      {status?.toolError && (
        <div className="border border-oxblood/40 bg-oxblood/5 rounded p-3 text-sm">
          <div className="font-medium text-oxblood mb-1">Backups are unavailable</div>
          {status.toolError}
        </div>
      )}

      <section className="border border-ink/10 rounded p-5 bg-white space-y-3">
        <h2 className="font-display text-lg">Create a backup</h2>
        {status && (
          <dl className="text-xs text-ink/60 grid grid-cols-[9rem_1fr] gap-y-1">
            <dt>App version</dt>
            <dd>{status.appVersion}</dd>
            <dt>Database</dt>
            <dd>{status.database}</dd>
            <dt>Included data</dt>
            <dd>
              {Object.entries(status.includes)
                .map(([k, present]) => `${k}${present ? '' : ' (empty)'}`)
                .join(', ')}
            </dd>
            <dt>Master key</dt>
            <dd className="font-mono">{status.masterKeyFingerprint}</dd>
          </dl>
        )}
        <label className="block text-sm">
          Passphrase
          <input
            type="password"
            value={passphrase}
            onChange={(e) => setPassphrase(e.target.value)}
            placeholder={`at least ${minLen} characters`}
            className="mt-1 w-full px-2 py-1 border border-ink/20 rounded"
          />
        </label>
        <label className="block text-sm">
          Confirm passphrase
          <input
            type="password"
            value={confirmPass}
            onChange={(e) => setConfirmPass(e.target.value)}
            className="mt-1 w-full px-2 py-1 border border-ink/20 rounded"
          />
        </label>
        <p className="text-xs text-ink/50">
          There is no recovery if this passphrase is lost — the archive is encrypted with it and
          nothing on this server can open it afterwards.
        </p>
        <button
          onClick={() => void createBackup()}
          disabled={!passOk || busy || Boolean(status?.toolError)}
          className="px-3 py-1.5 rounded text-sm bg-ink text-paper hover:bg-ink/90 disabled:opacity-40"
        >
          {busy ? 'Building archive…' : 'Create and download backup'}
        </button>
        {busy && (
          <p className="text-xs text-ink/50">
            Large installs can take several minutes. Leave this tab open.
          </p>
        )}
        {note && <div className="text-sm text-moss">{note}</div>}
      </section>

      <section className="border border-oxblood/30 rounded p-5 bg-white space-y-3">
        <h2 className="font-display text-lg">Restore onto this server</h2>
        <div className="border border-oxblood/40 bg-oxblood/5 rounded p-3 text-sm">
          <strong>This replaces everything.</strong> The current database, uploaded documents and
          rendered deliverables on this server are overwritten by the archive's contents. Take a
          backup of this server first if it holds anything you need.
        </div>
        <label className="block text-sm">
          Backup file
          <input
            type="file"
            accept=".vtbk"
            onChange={(e) => setFile(e.target.files?.[0] ?? null)}
            className="mt-1 block w-full text-sm"
          />
        </label>
        <label className="block text-sm">
          Passphrase
          <input
            type="password"
            value={restorePass}
            onChange={(e) => setRestorePass(e.target.value)}
            className="mt-1 w-full px-2 py-1 border border-ink/20 rounded"
          />
        </label>
        <label className="block text-sm">
          Type <code className="font-mono">REPLACE</code> to confirm
          <input
            value={restoreTyped}
            onChange={(e) => setRestoreTyped(e.target.value)}
            className="mt-1 w-full px-2 py-1 border border-ink/20 rounded"
          />
        </label>
        <button
          onClick={() => void runRestore()}
          disabled={!file || !restorePass || restoreTyped !== 'REPLACE' || running}
          className="px-3 py-1.5 rounded text-sm bg-oxblood text-paper hover:bg-oxblood/90 disabled:opacity-40"
        >
          {running ? 'Restoring…' : 'Restore from backup'}
        </button>
        {running && (
          <p className="text-xs text-ink/50">
            Restoring on the server. This continues even if you close this tab — do not restart the
            server until it finishes.
          </p>
        )}
        {restoreState?.status === 'failed' && (
          <div className="border border-oxblood/40 bg-oxblood/5 rounded p-3 text-sm">
            <div className="font-medium text-oxblood">Restore failed</div>
            <p className="mt-0.5">{restoreState.error}</p>
            <p className="text-xs text-ink/60 mt-1">
              {restoreState.harmless
                ? 'This was caught before anything was changed — fix the cause and try again.'
                : 'The database may be incomplete. Fix the cause and restore again before using the app.'}
            </p>
          </div>
        )}
        {restoreResult && (
          <div className="border border-moss/40 bg-moss/5 rounded p-3 text-sm space-y-1">
            <div className="font-medium">Restore complete</div>
            <div className="text-xs text-ink/70">
              From {restoreResult.restored.appVersion ?? 'unknown'} ·{' '}
              {restoreResult.restored.createdAt
                ? new Date(restoreResult.restored.createdAt).toLocaleString()
                : 'unknown date'}{' '}
              · {restoreResult.restored.files} files
            </div>
            {!restoreResult.masterKey.matches && (
              <div className="border border-gold/50 bg-gold/10 rounded p-2 mt-1">
                <div className="font-medium">Master key differs on this server</div>
                <p className="text-xs mt-0.5">{restoreResult.masterKey.action}</p>
                {restoreResult.masterKey.keyFromArchive && (
                  <p className="text-xs mt-1">
                    MASTER_KEY from the archive:{' '}
                    <code className="font-mono break-all">
                      {restoreResult.masterKey.keyFromArchive}
                    </code>
                  </p>
                )}
              </div>
            )}
            <p className="text-xs">Restart the API container to pick up the restored data.</p>
          </div>
        )}
      </section>

      {error && <div className="text-oxblood text-sm whitespace-pre-wrap">{error}</div>}
    </div>
  );
}
