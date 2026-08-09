// Admin → Backup & restore (DR v2).
//
// Backups are server-side jobs retained in the appliance's backups volume;
// this page starts one, watches its durable status, and lists the finished
// archives for streamed download (a plain link — the browser saves the
// stream, nothing is buffered in memory) or delete. Restores go through
// the scratch-database engine: choose an upload or a retained archive, and
// the journal renders as a phase checklist with rollback available while
// the previous generation exists.
import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { api, apiFetch, apiUrl } from '../../lib/api';
import { RestoreFailure, RestorePhases, type JournalView } from '../../components/RestorePhases';

interface BackupPageStatus {
  appVersion: string;
  pgTools: { pg_dump?: string; pg_restore?: string; error?: string };
  dirs: Record<string, boolean>;
  backupDirFreeBytes: number | null;
  masterKeyFingerprint: string;
  minPassphrase: number;
}

interface BackupJob {
  status: 'idle' | 'running' | 'succeeded' | 'failed';
  phase?: 'snapshot' | 'dump' | 'archive' | 'finalize';
  archive?: { bytesWritten: number; currentEntry: string };
  file?: { name: string; size: number };
  error?: string;
}

interface ArchiveInfo {
  name: string;
  size: number;
  createdAt: string;
}

function fmtBytes(n: number): string {
  if (n >= 1e9) return `${(n / 1e9).toFixed(1)} GB`;
  if (n >= 1e6) return `${(n / 1e6).toFixed(1)} MB`;
  return `${Math.ceil(n / 1e3)} KB`;
}

export function AdminBackupPage() {
  const qc = useQueryClient();
  const { data: status } = useQuery<BackupPageStatus>({
    queryKey: ['admin', 'backup', 'status'],
    queryFn: () => api('/api/admin/backup/status'),
  });

  const { data: job } = useQuery<BackupJob>({
    queryKey: ['admin', 'backup', 'job'],
    queryFn: () => api('/api/admin/backup/jobs/current'),
    refetchInterval: (q) => (q.state.data?.status === 'running' ? 1500 : false),
  });

  const { data: archives } = useQuery<{ archives: ArchiveInfo[] }>({
    queryKey: ['admin', 'backup', 'archives'],
    queryFn: () => api('/api/admin/backup/archives'),
    refetchInterval: job?.status === 'running' ? 3000 : false,
  });

  const { data: restore } = useQuery<JournalView>({
    queryKey: ['admin', 'backup', 'restore-status'],
    queryFn: () => api('/api/admin/backup/restore/status'),
    refetchInterval: (q) => (q.state.data?.status === 'running' ? 1500 : false),
  });

  const [passphrase, setPassphrase] = useState('');
  const [confirmPass, setConfirmPass] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const [mode, setMode] = useState<'upload' | 'archive'>('upload');
  const [file, setFile] = useState<File | null>(null);
  const [archiveName, setArchiveName] = useState('');
  const [restorePass, setRestorePass] = useState('');
  const [restoreTyped, setRestoreTyped] = useState('');

  const minLen = status?.minPassphrase ?? 12;
  const passOk = passphrase.length >= minLen && passphrase === confirmPass;
  const backupRunning = job?.status === 'running';
  const restoreRunning = restore?.status === 'running';
  const toolsBroken = Boolean(status?.pgTools.error);

  const refresh = () => {
    void qc.invalidateQueries({ queryKey: ['admin', 'backup'] });
  };

  async function createBackup() {
    setBusy(true);
    setError(null);
    try {
      await api('/api/admin/backup', {
        method: 'POST',
        body: JSON.stringify({ passphrase }),
      });
      setPassphrase('');
      setConfirmPass('');
      refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  async function deleteArchive(name: string) {
    if (!window.confirm(`Delete ${name}? A deleted archive cannot be recovered.`)) return;
    try {
      await api(`/api/admin/backup/archives/${encodeURIComponent(name)}`, { method: 'DELETE' });
      refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  async function startRestore() {
    setBusy(true);
    setError(null);
    try {
      if (mode === 'upload') {
        if (!file) return;
        const form = new FormData();
        form.append('file', file);
        form.append('passphrase', restorePass);
        form.append('confirm', 'replace-all-data');
        await apiFetch('/api/admin/backup/restore', { method: 'POST', body: form });
      } else {
        await api('/api/admin/backup/restore', {
          method: 'POST',
          body: JSON.stringify({
            archive: archiveName,
            passphrase: restorePass,
            confirm: 'replace-all-data',
          }),
        });
      }
      setRestoreTyped('');
      refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  async function rollback() {
    if (
      !window.confirm(
        'Roll back to the previous generation? The current database and files will be set aside.',
      )
    )
      return;
    try {
      await api('/api/admin/backup/restore/rollback', {
        method: 'POST',
        body: JSON.stringify({ confirm: 'rollback' }),
      });
      refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  return (
    <div className="max-w-3xl space-y-8">
      <header>
        <h1 className="font-display text-2xl">Backup &amp; restore</h1>
        <p className="text-sm text-ink/60 mt-1">
          Encrypted archives carry the database, uploads, deliverables, workspaces, and the
          MASTER_KEY — everything a new server needs. App {status?.appVersion} · key fingerprint{' '}
          <span className="font-mono">{status?.masterKeyFingerprint}</span>
          {status?.backupDirFreeBytes != null &&
            ` · ${fmtBytes(status.backupDirFreeBytes)} free on the backups volume`}
        </p>
        {toolsBroken && (
          <p className="text-oxblood text-sm mt-2">
            PostgreSQL client tools are missing: {status?.pgTools.error}
          </p>
        )}
      </header>

      {/* ── create ──────────────────────────────────────────────────── */}
      <section className="space-y-3">
        <h2 className="font-display text-lg">Create a backup</h2>
        <p className="text-sm text-ink/60">
          The passphrase encrypts the archive and is NOT stored anywhere — lose it and the backup is
          unreadable. Minimum {minLen} characters.
        </p>
        <div className="grid sm:grid-cols-2 gap-2">
          <input
            type="password"
            placeholder="passphrase"
            value={passphrase}
            disabled={backupRunning}
            onChange={(e) => setPassphrase(e.target.value)}
            className="px-3 py-2 border border-ink/20 rounded font-mono text-sm"
          />
          <input
            type="password"
            placeholder="repeat passphrase"
            value={confirmPass}
            disabled={backupRunning}
            onChange={(e) => setConfirmPass(e.target.value)}
            className="px-3 py-2 border border-ink/20 rounded font-mono text-sm"
          />
        </div>
        <button
          onClick={() => void createBackup()}
          disabled={!passOk || busy || backupRunning || restoreRunning || toolsBroken}
          className="px-3 py-1.5 rounded text-sm bg-ink text-paper hover:bg-ink/90 disabled:opacity-40"
        >
          {backupRunning ? 'Building…' : 'Create backup'}
        </button>
        {backupRunning && (
          <div className="text-sm text-ink/60">
            {job?.phase === 'dump' && 'Dumping the database…'}
            {job?.phase === 'snapshot' && 'Snapshotting…'}
            {job?.phase === 'archive' &&
              `Encrypting ${job.archive?.currentEntry ?? ''} — ${fmtBytes(job.archive?.bytesWritten ?? 0)} written`}
            {job?.phase === 'finalize' && 'Finishing…'}
          </div>
        )}
        {job?.status === 'failed' && (
          <div className="text-oxblood text-sm">Backup failed: {job.error}</div>
        )}
        {job?.status === 'succeeded' && job.file && (
          <div className="text-sm text-ink/70">
            Latest backup: <span className="font-mono">{job.file.name}</span> (
            {fmtBytes(job.file.size)})
          </div>
        )}
      </section>

      {/* ── archives ────────────────────────────────────────────────── */}
      <section className="space-y-3">
        <h2 className="font-display text-lg">Archives on this server</h2>
        {!archives?.archives.length && (
          <p className="text-sm text-ink/50">No archives yet. Create one above.</p>
        )}
        {Boolean(archives?.archives.length) && (
          <table className="w-full text-sm">
            <thead className="text-left text-xs uppercase tracking-wider text-ink/50">
              <tr>
                <th className="py-1 pr-4">Archive</th>
                <th className="py-1 pr-4">Size</th>
                <th className="py-1 pr-4">Created</th>
                <th className="py-1" />
              </tr>
            </thead>
            <tbody>
              {archives!.archives.map((a) => (
                <tr key={a.name} className="border-t border-ink/10">
                  <td className="py-2 pr-4 font-mono text-xs">{a.name}</td>
                  <td className="py-2 pr-4">{fmtBytes(a.size)}</td>
                  <td className="py-2 pr-4">{new Date(a.createdAt).toLocaleString()}</td>
                  <td className="py-2 text-right space-x-3 whitespace-nowrap">
                    <a
                      href={apiUrl(
                        `/api/admin/backup/archives/${encodeURIComponent(a.name)}/download`,
                      )}
                      className="underline text-ink/70 hover:text-ink"
                    >
                      Download
                    </a>
                    <button
                      onClick={() => void deleteArchive(a.name)}
                      className="underline text-oxblood/80 hover:text-oxblood"
                    >
                      Delete
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        <p className="text-xs text-ink/50">
          Download moves an archive off this server — do that regularly; a backup that lives only on
          the machine it protects is not disaster recovery.
        </p>
      </section>

      {/* ── restore ─────────────────────────────────────────────────── */}
      <section className="space-y-3">
        <h2 className="font-display text-lg">Restore</h2>
        <p className="text-sm text-ink/60">
          The archive is loaded and verified in a scratch database first; this install only changes
          at the final swap, and the previous generation stays available for rollback.
        </p>
        <div className="flex gap-4 text-sm">
          <label className="flex items-center gap-1.5">
            <input
              type="radio"
              checked={mode === 'upload'}
              onChange={() => setMode('upload')}
              disabled={restoreRunning}
            />
            Upload a file
          </label>
          <label className="flex items-center gap-1.5">
            <input
              type="radio"
              checked={mode === 'archive'}
              onChange={() => setMode('archive')}
              disabled={restoreRunning}
            />
            Use a retained archive
          </label>
        </div>
        {mode === 'upload' ? (
          <input
            type="file"
            accept=".vtbk"
            disabled={restoreRunning}
            onChange={(e) => setFile(e.target.files?.[0] ?? null)}
            className="block w-full text-sm"
          />
        ) : (
          <select
            value={archiveName}
            disabled={restoreRunning}
            onChange={(e) => setArchiveName(e.target.value)}
            className="w-full px-3 py-2 border border-ink/20 rounded text-sm"
          >
            <option value="">Choose an archive…</option>
            {archives?.archives.map((a) => (
              <option key={a.name} value={a.name}>
                {a.name}
              </option>
            ))}
          </select>
        )}
        <input
          type="password"
          placeholder="archive passphrase"
          value={restorePass}
          disabled={restoreRunning}
          onChange={(e) => setRestorePass(e.target.value)}
          className="w-full px-3 py-2 border border-ink/20 rounded font-mono text-sm"
        />
        <label className="block text-sm">
          Type <span className="font-mono">REPLACE</span> to confirm this replaces every user, chat,
          client, and file on this server:
          <input
            value={restoreTyped}
            disabled={restoreRunning}
            onChange={(e) => setRestoreTyped(e.target.value)}
            className="mt-1 w-full px-3 py-2 border border-ink/20 rounded font-mono text-sm"
          />
        </label>
        <button
          onClick={() => void startRestore()}
          disabled={
            busy ||
            restoreRunning ||
            backupRunning ||
            restoreTyped !== 'REPLACE' ||
            !restorePass ||
            (mode === 'upload' ? !file : !archiveName)
          }
          className="px-3 py-1.5 rounded text-sm bg-oxblood text-paper hover:bg-oxblood/90 disabled:opacity-40"
        >
          {restoreRunning ? 'Restoring…' : 'Restore'}
        </button>

        {restore && restore.status !== 'idle' && (
          <div className="space-y-2 border border-ink/10 rounded p-3">
            <RestorePhases journal={restore} />
            {(restore.status === 'failed' || restore.status === 'interrupted') && (
              <RestoreFailure journal={restore} />
            )}
            {restore.status === 'succeeded' && (
              <div className="border border-moss/40 bg-moss/5 rounded p-3 text-sm space-y-1">
                <div className="font-medium">Restore complete — restart the api container</div>
                {restore.result && !restore.result.masterKeyMatches && (
                  <p className="text-oxblood">
                    The archive was made with a different MASTER_KEY. Set it on this server to the
                    value below, then restart — until then the stored Anthropic key and SMTP
                    password cannot be decrypted.
                    {restore.result.keyFromArchive && (
                      <span className="block font-mono text-xs mt-1">
                        {restore.result.keyFromArchive}
                      </span>
                    )}
                  </p>
                )}
              </div>
            )}
            {restore.rollbackAvailable && !restoreRunning && (
              <button
                onClick={() => void rollback()}
                className="px-3 py-1.5 rounded text-sm border border-ink/30 hover:bg-ink/5"
              >
                Roll back to the previous generation
              </button>
            )}
          </div>
        )}
      </section>

      {error && <div className="text-oxblood text-sm">{error}</div>}
    </div>
  );
}
