// Restore-during-first-run.
//
// Standing up a replacement server and restoring the old one onto it is a
// single act, so it belongs in the wizard rather than behind a login the
// operator does not have yet — the accounts they would log in with are
// inside the archive.
//
// It is also the only moment a restore is completely safe: no users, no
// sessions, nothing to lose if it fails.
import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { api, apiFetch } from '../lib/api';

type RestoreState =
  | { status: 'idle' }
  | { status: 'running'; startedAt: string; step: string }
  | { status: 'succeeded'; finishedAt: string; result: { restored?: { files?: number } } }
  | { status: 'failed'; finishedAt: string; error: string; code: string; harmless: boolean };

export function SetupRestore({ onCancel }: { onCancel: () => void }) {
  const [file, setFile] = useState<File | null>(null);
  const [passphrase, setPassphrase] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const { data: state } = useQuery<RestoreState>({
    queryKey: ['setup', 'restore-status'],
    queryFn: () => api('/api/setup/restore/status', { skipRefresh: true }),
    refetchInterval: (q) => (q.state.data?.status === 'running' ? 2000 : false),
  });
  const running = state?.status === 'running' || submitting;

  async function start() {
    if (!file) return;
    setSubmitting(true);
    setError(null);
    try {
      const form = new FormData();
      form.append('file', file);
      form.append('passphrase', passphrase);
      await apiFetch('/api/setup/restore', { method: 'POST', body: form });
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSubmitting(false);
    }
  }

  if (state?.status === 'succeeded') {
    return (
      <div className="space-y-3">
        <div className="border border-moss/40 bg-moss/5 rounded p-3 text-sm">
          <div className="font-medium">Restore complete</div>
          <p className="mt-1 text-ink/70">
            This server now holds the backup&apos;s data, including its user accounts. Sign in with
            the credentials from the server the backup came from — the accounts that existed here
            before have been replaced.
          </p>
        </div>
        <a
          href="/login"
          className="inline-block px-3 py-1.5 rounded text-sm bg-ink text-paper hover:bg-ink/90"
        >
          Go to sign in
        </a>
      </div>
    );
  }

  return (
    <div className="space-y-3">
      <p className="text-sm text-ink/70">
        Moving from another server? Restore its backup here instead of creating a new account. The
        archive brings its own users, clients, plans and settings.
      </p>
      <label className="block text-sm">
        Backup file (.vtbk)
        <input
          type="file"
          accept=".vtbk"
          disabled={running}
          onChange={(e) => setFile(e.target.files?.[0] ?? null)}
          className="mt-1 block w-full text-sm"
        />
      </label>
      <label className="block text-sm">
        Passphrase
        <input
          type="password"
          value={passphrase}
          disabled={running}
          onChange={(e) => setPassphrase(e.target.value)}
          className="mt-1 w-full px-3 py-2 border border-ink/20 rounded font-mono text-sm"
        />
      </label>

      {state?.status === 'running' && (
        <div className="text-xs text-ink/60">
          Restoring — {state.step}. This continues on the server even if you close the tab; a large
          archive can take several minutes.
        </div>
      )}
      {state?.status === 'failed' && (
        <div className="border border-oxblood/40 bg-oxblood/5 rounded p-3 text-sm">
          <div className="font-medium text-oxblood">Restore failed</div>
          <p className="mt-0.5">{state.error}</p>
          <p className="text-xs text-ink/60 mt-1">
            {state.harmless
              ? 'Nothing was changed — fix the cause and try again.'
              : 'The database may be incomplete. Resolve the cause before using this install.'}
          </p>
        </div>
      )}
      {error && <div className="text-oxblood text-sm">{error}</div>}

      <div className="flex items-center gap-2">
        <button
          onClick={() => void start()}
          disabled={!file || !passphrase || running}
          className="px-3 py-1.5 rounded text-sm bg-ink text-paper hover:bg-ink/90 disabled:opacity-40"
        >
          {running ? 'Restoring…' : 'Restore from backup'}
        </button>
        <button
          onClick={onCancel}
          disabled={running}
          className="px-3 py-1.5 text-sm underline text-ink/60 disabled:opacity-40"
        >
          Set up a new install instead
        </button>
      </div>
    </div>
  );
}
