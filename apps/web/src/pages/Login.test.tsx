// SSO hand-off on the login page: a `#sso_code` fragment is read once,
// scrubbed from the URL, exchanged for a session, and never rendered.
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';

const apiMock = vi.fn();
vi.mock('../lib/api', () => ({
  api: (...args: unknown[]) => apiMock(...args),
  apiFetch: vi.fn(),
  apiUrl: (p: string) => `/${p.replace(/^\//, '')}`,
  authedFetch: vi.fn(),
  SPA_BASE_PATH: '',
}));

const completeLogin = vi.fn();
vi.mock('../components/AuthProvider', () => ({
  useAuth: () => ({
    user: null,
    loading: false,
    login: vi.fn(),
    completeLogin,
    logout: vi.fn(),
    refresh: vi.fn(),
  }),
}));

// The package panel is exercised in its own repo; here it just has to render its children.
vi.mock('@kisaesdevlab/vibe-auth/react', () => ({
  LoginPanel: ({ children }: { children?: React.ReactNode }) => (
    <div data-testid="login-panel">{children}</div>
  ),
}));

import { LoginPage, parseSsoCode } from './Login';

function renderLogin() {
  return render(
    <MemoryRouter>
      <LoginPage />
    </MemoryRouter>,
  );
}

beforeEach(() => {
  apiMock.mockReset();
  completeLogin.mockReset();
  window.history.replaceState(null, '', '/login');
});

describe('parseSsoCode', () => {
  it('reads sso_code off a fragment and ignores everything else', () => {
    expect(parseSsoCode('#sso_code=abc')).toBe('abc');
    expect(parseSsoCode('sso_code=a%20b&x=1')).toBe('a b');
    expect(parseSsoCode('#other=1')).toBeNull();
    expect(parseSsoCode('')).toBeNull();
    expect(parseSsoCode('#sso_code=')).toBeNull();
  });
});

describe('LoginPage SSO landing', () => {
  it('exchanges the code, stores the session, and scrubs the fragment', async () => {
    const session = {
      access_token: 'a',
      refresh_token: 'r',
      user: { id: 'u1', email: 'p@f.test', role: 'user' },
    };
    apiMock.mockImplementation(async (path: string) => {
      if (path === '/api/setup/status') return { admin_exists: true };
      if (path === '/api/auth/sso/exchange') return session;
      throw new Error(`unexpected ${path}`);
    });
    window.history.replaceState(null, '', '/login#sso_code=one-time-code');
    renderLogin();
    expect(window.location.hash).toBe('');
    expect(screen.getByText('Completing sign-in…')).toBeInTheDocument();
    await waitFor(() => expect(completeLogin).toHaveBeenCalledWith(session));
    expect(apiMock).toHaveBeenCalledWith('/api/auth/sso/exchange', {
      method: 'POST',
      body: JSON.stringify({ code: 'one-time-code' }),
      skipRefresh: true,
    });
    expect(document.body.textContent).not.toContain('one-time-code');
  });

  it('a spent code falls back to the sign-in form with a plain explanation', async () => {
    apiMock.mockImplementation(async (path: string) => {
      if (path === '/api/setup/status') return { admin_exists: true };
      throw new Error('invalid_or_expired_code');
    });
    window.history.replaceState(null, '', '/login#sso_code=stale');
    renderLogin();
    await waitFor(() =>
      expect(screen.getByText(/expired or was already used/)).toBeInTheDocument(),
    );
    expect(screen.getByTestId('login-panel')).toBeInTheDocument();
    expect(completeLogin).not.toHaveBeenCalled();
  });

  it('without a fragment the ordinary form renders inside the panel', async () => {
    apiMock.mockResolvedValue({ admin_exists: true });
    renderLogin();
    expect(screen.getByText('Sign in to continue.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Sign in' })).toBeInTheDocument();
    await waitFor(() =>
      expect(apiMock).toHaveBeenCalledWith('/api/setup/status', { skipRefresh: true }),
    );
    expect(apiMock).not.toHaveBeenCalledWith('/api/auth/sso/exchange', expect.anything());
  });
});
