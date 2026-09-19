// Phase 3 — login page.
// SSO (Vibe Auth): the package's <LoginPanel> wraps the password form. In
// `local` mode it renders the form alone (no visual change); in `both` it
// adds the "Sign in with …" button; in `oidc_only` it hides the form —
// except on the hidden /login/local route (`breakglass`), which keeps the
// password form for the break-glass admin.
//
// An SSO login ends with a redirect to `/login#sso_code=<code>`: a one-time
// code (60 s) that POST /api/auth/sso/exchange turns into the same
// access + refresh pair a password login returns. The code is read once
// and scrubbed from the URL before anything else renders, so it survives
// in neither history nor a copied link.
import { useState, useEffect, type FormEvent } from 'react';
import { Navigate, useLocation, Link, useSearchParams } from 'react-router-dom';
import { LoginPanel } from '@kisaesdevlab/vibe-auth/react';
import { useAuth, type LoginResponse } from '../components/AuthProvider';
import { api, apiUrl } from '../lib/api';

/** The SPA prefix the Vibe Auth components build their URLs with ('' or e.g. '/tax'). */
export const AUTH_BASE_PATH = import.meta.env.BASE_URL.replace(/\/$/, '');

/** Pure so the parsing is tested; the page clears the fragment as soon as it has read it. */
export function parseSsoCode(hash: string): string | null {
  const raw = hash.startsWith('#') ? hash.slice(1) : hash;
  if (!raw) return null;
  const code = new URLSearchParams(raw).get('sso_code')?.trim();
  return code ? code : null;
}

export function LoginPage({ breakglass = false }: { breakglass?: boolean } = {}) {
  const { user, login, completeLogin } = useAuth();
  const location = useLocation();
  const [searchParams] = useSearchParams();
  const resetOk = searchParams.get('reset') === 'ok';
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  // A code on the fragment means we are the landing page of an SSO login.
  // Read it once and scrub the URL; the effect below turns it into a session.
  const [ssoCode] = useState<string | null>(() => {
    const code = parseSsoCode(window.location.hash);
    if (code)
      window.history.replaceState(null, '', window.location.pathname + window.location.search);
    return code;
  });
  const [ssoPending, setSsoPending] = useState(!!ssoCode);
  // Detect a fresh appliance with no admin user yet and route the visitor
  // to /setup. Without this, the very first login attempt fails as
  // "invalid_credentials" with no hint of where to go.
  const [needsSetup, setNeedsSetup] = useState<boolean | null>(null);
  useEffect(() => {
    let cancelled = false;
    api<{ admin_exists: boolean }>('/api/setup/status', { skipRefresh: true })
      .then((r) => {
        if (!cancelled) setNeedsSetup(!r.admin_exists);
      })
      .catch(() => {
        if (!cancelled) setNeedsSetup(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  // ── single sign-on landing ──────────────────────────────────────────
  useEffect(() => {
    if (!ssoCode) return;
    let alive = true;
    api<LoginResponse>('/api/auth/sso/exchange', {
      method: 'POST',
      body: JSON.stringify({ code: ssoCode }),
      skipRefresh: true,
    })
      .then((r) => {
        if (alive) completeLogin(r);
      })
      .catch((err: Error) => {
        if (!alive) return;
        setSsoPending(false);
        setError(
          err.message === 'invalid_or_expired_code'
            ? 'That sign-in link has expired or was already used. Please sign in again.'
            : `Single sign-on failed (${err.message}).`,
        );
      });
    return () => {
      alive = false;
    };
  }, [ssoCode]);

  if (user) {
    const from =
      (location.state as { from?: { pathname: string } } | null)?.from?.pathname ?? '/research';
    return <Navigate to={from} replace />;
  }
  if (needsSetup) return <Navigate to="/setup" replace />;

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await login(email, password);
    } catch (err) {
      setError(
        (err as Error).message === 'local_login_disabled'
          ? 'Password sign-in is disabled for this firm. Use single sign-on.'
          : ((err as Error).message ?? 'Login failed'),
      );
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="min-h-screen grid place-items-center bg-paper px-4 py-8">
      <div className="w-full max-w-[380px] bg-white border border-ink/10 rounded-md p-6 sm:p-8 shadow-sm">
        <h1 className="font-display text-3xl mb-1">Vibe Tax Research</h1>
        <p className="text-ink/60 text-sm mb-6">
          {ssoPending
            ? 'Completing sign-in…'
            : breakglass
              ? 'Break-glass sign-in with a local password.'
              : 'Sign in to continue.'}
        </p>
        {resetOk && (
          <div className="mb-4 text-sm text-moss border border-moss/30 bg-moss/5 rounded p-3">
            Password reset successfully. Sign in with your new password.
          </div>
        )}
        {/* Outside the form: in SSO-only mode the panel hides the form, and a
            failed hand-off still needs somewhere to say so. */}
        {error && !ssoPending && <div className="mb-4 text-sm text-oxblood">{error}</div>}
        {ssoPending ? (
          <p className="text-sm text-ink/60">Signing you in with your identity provider.</p>
        ) : (
          <LoginPanel
            basePath={AUTH_BASE_PATH}
            returnTo={apiUrl('login')}
            breakglass={breakglass}
            classNames={{
              root: 'space-y-4',
              button:
                'block w-full py-2 text-center border border-ink/20 rounded font-display tracking-wide hover:bg-ink/5',
              divider: 'text-center text-xs uppercase tracking-wider text-ink/40',
              note: 'text-xs text-ink/60 text-center',
            }}
          >
            <form onSubmit={onSubmit} className="space-y-4">
              <label className="block">
                <div className="text-xs uppercase tracking-wider text-ink/60 mb-1">Email</div>
                <input
                  type="email"
                  required
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  className="w-full px-3 py-2 border border-ink/20 rounded font-mono text-sm"
                  autoComplete="email"
                />
              </label>
              <label className="block">
                <div className="text-xs uppercase tracking-wider text-ink/60 mb-1">Password</div>
                <input
                  type="password"
                  required
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  className="w-full px-3 py-2 border border-ink/20 rounded font-mono text-sm"
                  autoComplete="current-password"
                />
              </label>
              <button
                type="submit"
                disabled={busy}
                className="w-full py-2 bg-ink text-paper rounded font-display tracking-wide disabled:opacity-50"
              >
                {busy ? 'Signing in…' : 'Sign in'}
              </button>
            </form>
            <div className="text-center">
              <Link to="/forgot" className="text-xs text-ink/60 hover:text-ink underline">
                Forgot password?
              </Link>
            </div>
          </LoginPanel>
        )}
      </div>
    </div>
  );
}
