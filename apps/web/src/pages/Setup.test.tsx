// Regression: in restore mode the wizard must NOT render its own Next
// button. It used to, as the page's most prominent CTA — clicking it ran
// the admin bootstrap with empty fields and surfaced an unexplained
// "bad_request" while the user thought they had submitted the restore.
import { describe, expect, it, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

vi.mock('../lib/api', () => ({
  api: vi.fn().mockResolvedValue({ admin_exists: false, status: 'idle' }),
  apiFetch: vi.fn(),
  apiUrl: (p: string) => p,
}));

import { SetupPage } from './Setup';

function renderSetup() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter>
        <SetupPage />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe('SetupPage restore mode', () => {
  it('shows Next on the admin step', () => {
    renderSetup();
    expect(screen.getByText('Next')).toBeInTheDocument();
  });

  it('hides the wizard Next button while the restore panel is open', () => {
    renderSetup();
    fireEvent.click(screen.getByText(/Restore from a backup instead/));
    expect(screen.getByText('Restore from backup')).toBeInTheDocument();
    expect(screen.queryByText('Next')).not.toBeInTheDocument();
    // Leaving restore mode brings the wizard controls back.
    fireEvent.click(screen.getByText(/Set up a new install instead/));
    expect(screen.getByText('Next')).toBeInTheDocument();
  });
});
