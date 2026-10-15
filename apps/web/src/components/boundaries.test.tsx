import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen } from '@testing-library/react';

const apiMock = vi.fn(async (..._args: unknown[]) => undefined);
vi.mock('../lib/api', () => ({
  api: (...args: unknown[]) => apiMock(...args),
  SPA_BASE_PATH: '',
}));
vi.mock('../lib/token-store', () => ({ tokenStore: { getAccess: () => 'token' } }));

import { PanelBoundary } from './panels/PanelBoundary';
import { AppErrorBoundary } from './AppErrorBoundary';

function Boom({ msg }: { msg: string }): JSX.Element {
  throw new TypeError(msg);
}

function lastReport(): Record<string, unknown> {
  const call = apiMock.mock.calls.at(-1) as [string, { body: string }];
  expect(call[0]).toBe('/api/client-errors');
  return JSON.parse(call[1].body) as Record<string, unknown>;
}

describe('error boundaries', () => {
  beforeEach(() => {
    apiMock.mockClear();
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
  });
  afterEach(() => vi.restoreAllMocks());

  it('a failing panel degrades to a notice, keeps siblings, and reports with ids', () => {
    render(
      <div>
        <p>answer text</p>
        <PanelBoundary
          name="Compliance"
          chatId="a1279f91-b049-4e88-9350-105d56ca4962"
          messageId="0b6e2c1e-8f43-4d55-9d0a-6b1b5f6a8a11"
        >
          <Boom msg="x.filter is not a function" />
        </PanelBoundary>
      </div>,
    );
    expect(screen.getByText('answer text')).toBeInTheDocument();
    expect(screen.getByText(/Compliance section .* could not be displayed/)).toBeInTheDocument();
    const r = lastReport();
    expect(r).toMatchObject({
      kind: 'panel',
      source: 'Compliance',
      message: 'TypeError: x.filter is not a function',
      chat_id: 'a1279f91-b049-4e88-9350-105d56ca4962',
      message_id: '0b6e2c1e-8f43-4d55-9d0a-6b1b5f6a8a11',
    });
    expect(String(r.component_stack)).toContain('Boom');
  });

  it('a page-level failure shows the recovery page instead of a blank screen', () => {
    render(
      <AppErrorBoundary>
        <Boom msg="page blew up" />
      </AppErrorBoundary>,
    );
    expect(screen.getByText('This page could not be displayed')).toBeInTheDocument();
    expect(screen.getByText('Back to research')).toHaveAttribute('href', '/research');
    expect(lastReport()).toMatchObject({ kind: 'app', message: 'TypeError: page blew up' });
  });

  it('reports a repeat of the same failure once per page load', () => {
    for (let i = 0; i < 3; i++) {
      render(
        <PanelBoundary name="Authorities" messageId="f1e2d3c4-b5a6-4978-8877-665544332211">
          <Boom msg="same failure" />
        </PanelBoundary>,
      );
    }
    expect(apiMock).toHaveBeenCalledTimes(1);
  });
});
