// DR v2 — the restore journal rendered as a phase checklist. Shared by the
// first-run wizard and Admin → Backup & restore so both surfaces tell the
// same story: which phase is running, byte/TOC progress for the long ones,
// and on failure the exact phase plus the pg_restore stderr tail.

export interface JournalView {
  status: 'running' | 'succeeded' | 'failed' | 'interrupted' | 'rolled_back' | 'idle';
  phase?: string;
  phases?: Record<
    string,
    { status: 'pending' | 'running' | 'done' | 'failed' | 'skipped'; note?: string }
  >;
  archive?: { appVersion: string; createdAt: string };
  extract?: { bytesRead: number; bytesTotal: number };
  load?: { tocTotal: number; tocDone: number; stderrTail?: string[] };
  error?: { phase: string; code: string; message: string; stderrTail?: string[] };
  result?: { masterKeyMatches: boolean; keyFromArchive: string | null; filesRestored: number };
  rollbackAvailable?: boolean;
}

const PHASE_LABELS: Array<[string, string]> = [
  ['inspect', 'Reading the archive manifest'],
  ['prepare', 'Preparing a scratch database'],
  ['extract', 'Decrypting and unpacking'],
  ['load', 'Loading the database'],
  ['verify', 'Verifying against the manifest'],
  ['files', 'Staging files'],
  ['swap', 'Swapping into place'],
  ['finalize', 'Finalizing'],
];

function gb(n: number): string {
  if (n >= 1e9) return `${(n / 1e9).toFixed(1)} GB`;
  if (n >= 1e6) return `${(n / 1e6).toFixed(1)} MB`;
  return `${Math.ceil(n / 1e3)} KB`;
}

function mark(status: string): string {
  if (status === 'done') return '✓';
  if (status === 'running') return '…';
  if (status === 'failed') return '✗';
  return '·';
}

export function RestorePhases({ journal }: { journal: JournalView }) {
  if (!journal.phases) return null;
  return (
    <div className="text-sm space-y-0.5" data-testid="restore-phases">
      {PHASE_LABELS.map(([key, label]) => {
        const p = journal.phases![key];
        if (!p) return null;
        const active = p.status === 'running';
        return (
          <div
            key={key}
            className={
              p.status === 'failed'
                ? 'text-oxblood'
                : active
                  ? 'text-ink'
                  : p.status === 'done'
                    ? 'text-ink/70'
                    : 'text-ink/35'
            }
          >
            <span className="inline-block w-4 font-mono">{mark(p.status)}</span>
            {label}
            {key === 'extract' && active && journal.extract && (
              <span className="text-ink/50">
                {' '}
                — {gb(journal.extract.bytesRead)} of {gb(journal.extract.bytesTotal)}
              </span>
            )}
            {key === 'load' && active && journal.load && journal.load.tocTotal > 0 && (
              <span className="text-ink/50">
                {' '}
                — {journal.load.tocDone} / {journal.load.tocTotal} items
              </span>
            )}
            {p.note && <span className="text-ink/50"> ({p.note})</span>}
          </div>
        );
      })}
    </div>
  );
}

export function RestoreFailure({ journal }: { journal: JournalView }) {
  if (!journal.error) return null;
  const preSwap =
    journal.error.code === 'restore_prerequisite' ||
    ['inspect', 'prepare', 'extract', 'load', 'verify', 'files'].includes(journal.error.phase);
  return (
    <div className="border border-oxblood/40 bg-oxblood/5 rounded p-3 text-sm space-y-1">
      <div className="font-medium text-oxblood">
        Restore {journal.status === 'interrupted' ? 'interrupted' : 'failed'} during “
        {journal.error.phase}”
      </div>
      <p>{journal.error.message}</p>
      <p className="text-xs text-ink/60">
        {preSwap
          ? 'Nothing was changed — the live install is untouched. Fix the cause and try again.'
          : 'The swap had begun; if the app is unhealthy, use rollback or the offline CLI (vibe-backup recover).'}
      </p>
      {journal.error.stderrTail && journal.error.stderrTail.length > 0 && (
        <pre className="mt-1 max-h-40 overflow-auto bg-ink/5 rounded p-2 text-xs font-mono whitespace-pre-wrap">
          {journal.error.stderrTail.join('\n')}
        </pre>
      )}
    </div>
  );
}
