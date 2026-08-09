// Restore-during-first-run.
//
// Standing up a replacement server and restoring the old one onto it is a
// single act, so it belongs in the wizard rather than behind a login the
// operator does not have yet — the accounts they would log in with are
// inside the archive.
//
// DR v2: the restore runs in the scratch-database engine and this panel
// renders the durable journal — real phases, byte/item progress, and on
// failure the exact phase plus the pg_restore stderr tail. The live
// install is untouched until the final swap, and the journal survives an
// api restart.
import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { api, apiFetch } from '../lib/api';
import { RestoreFailure, RestorePhases, type JournalView } from '../components/RestorePhases';

export function SetupRestore({ onCancel }: { onCancel: () => void }) {
  const [file, setFile] = useState<File | null>(null);
  const [passphrase, setPassphrase] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const { data: state } = useQuery<JournalView>({
    queryKey: ['setup', 'restore-status'],
    queryFn: () => api('/api/setup/restore/status', { skipRefresh: true }),
    refetchInterval: (q) => (q.state.data?.status === 'running' ? 1500 : false),
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
          {state.result && !state.result.masterKeyMatches && (
            <p className="mt-2 text-oxblood">
              The archive was made with a different MASTER_KEY. Set MASTER_KEY on this server to the
              value from the source server, then restart — until then the stored Anthropic key and
              SMTP password cannot be decrypted.
              {state.result.keyFromArchive && (
                <span className="block font-mono text-xs mt-1">{state.result.keyFromArchive}</span>
              )}
            </p>
          )}
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
        <div className="space-y-2">
          <RestorePhases journal={state} />
          <p className="text-xs text-ink/60">
            This continues on the server even if you close the tab; the database only changes at the
            final “swap” step.
          </p>
        </div>
      )}
      {(state?.status === 'failed' || state?.status === 'interrupted') && (
        <RestoreFailure journal={state} />
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
