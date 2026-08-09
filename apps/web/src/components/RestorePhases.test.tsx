// DR v2 — the journal-driven phase checklist renders real progress and
// failure evidence.
import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import { RestorePhases, RestoreFailure, type JournalView } from './RestorePhases';

function journal(overrides: Partial<JournalView>): JournalView {
  return {
    status: 'running',
    phase: 'load',
    phases: {
      inspect: { status: 'done' },
      prepare: { status: 'done' },
      extract: { status: 'done' },
      load: { status: 'running' },
      verify: { status: 'pending' },
      files: { status: 'pending' },
      swap: { status: 'pending' },
      finalize: { status: 'pending' },
    },
    ...overrides,
  };
}

describe('RestorePhases', () => {
  it('renders every phase with load progress', () => {
    render(
      <RestorePhases journal={journal({ load: { tocTotal: 120, tocDone: 37, stderrTail: [] } })} />,
    );
    expect(screen.getByText(/Loading the database/)).toBeInTheDocument();
    expect(screen.getByText(/37 \/ 120 items/)).toBeInTheDocument();
    expect(screen.getByText(/Verifying against the manifest/)).toBeInTheDocument();
  });

  it('shows extract byte progress while extracting', () => {
    const j = journal({ phase: 'extract' });
    j.phases!.extract = { status: 'running' };
    j.phases!.load = { status: 'pending' };
    j.extract = { bytesRead: 500e6, bytesTotal: 2e9 };
    render(<RestorePhases journal={j} />);
    expect(screen.getByText(/500\.0 MB of 2\.0 GB/)).toBeInTheDocument();
  });
});

describe('RestoreFailure', () => {
  it('says the live install is untouched for pre-swap failures and shows stderr', () => {
    const j = journal({
      status: 'failed',
      error: {
        phase: 'verify',
        code: 'verify_failed',
        message: 'Restored data does not match the backup manifest',
        stderrTail: ['pg_restore: creating TABLE users', 'pg_restore: error: whatever'],
      },
    });
    j.phases!.verify = { status: 'failed' };
    render(<RestoreFailure journal={j} />);
    expect(screen.getByText(/failed during “verify”/)).toBeInTheDocument();
    expect(screen.getByText(/live install is untouched/)).toBeInTheDocument();
    expect(screen.getByText(/pg_restore: error: whatever/)).toBeInTheDocument();
  });

  it('points at rollback/recover for mid-swap failures', () => {
    const j = journal({
      status: 'failed',
      error: { phase: 'swap', code: 'swap_failed', message: 'rename refused' },
    });
    render(<RestoreFailure journal={j} />);
    expect(screen.getByText(/rollback or the offline CLI/)).toBeInTheDocument();
  });
});
