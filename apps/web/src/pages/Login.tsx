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
import { api, apiUrl, SPA_BASE_PATH } from '../lib/api';

/** Pure so the parsing is tested; the page clears the fragment as soon as it has read it. */
export function parseSsoCode(hash: string): string | null {
  const raw = hash.startsWith('#') ? hash.slice(1) : hash;
  if (!raw) return null;
  const code = new URLSearchParams(raw).get('sso_code')?.trim();
  return code ? code : null;
}

// The code is single-use and React.StrictMode runs effects twice in
// development (mount → simulated unmount → mount): a second POST would race
// the first for the same code, and the winner's result would be thrown away
// by the first effect's cleanup. Memoising the exchange per code, outside the
// component, makes both mounts share ONE request and its result.
const exchanges = new Map<string, Promise<LoginResponse>>();
function exchangeOnce(code: string): Promise<LoginResponse> {
  let p = exchanges.get(code);
  if (!p) {
    p = api<LoginResponse>('/api/auth/sso/exchange', {
      method: 'POST',
      body: JSON.stringify({ code }),
      skipRefresh: true,
    });
    exchanges.set(code, p);
  }
  return p;
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
    // No "alive" guard on purpose: completeLogin writes the provider's state,
    // not this component's, and must land even if StrictMode unmounted the
    // instance that started the exchange.
    exchangeOnce(ssoCode)
      .then((r) => completeLogin(r))
      .catch((err: Error) => {
        setSsoPending(false);
        setError(
          err.message === 'invalid_or_expired_code'
            ? 'That sign-in link has expired or was already used. Please sign in again.'
            : `Single sign-on failed (${err.message}).`,
        );
      });
  }, [ssoCode, completeLogin]);

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
      const code = (err as Error).message;
      setError(
        code === 'local_login_disabled'
          ? 'Password sign-in is disabled for this firm. Use single sign-on.'
          : code === 'bad_request'
            ? 'Enter your email address and password.'
            : (code ?? 'Login failed'),
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
            basePath={SPA_BASE_PATH}
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
                <div className="text-xs uppercase tracking-wider text-ink/60 mb-1">
                  {breakglass ? 'Email or username' : 'Email'}
                </div>
                {/* type="text", not "email": the break-glass admin signs in as
                    the bare username `vibe-breakglass` (all the Appliance
                    prints), which a browser's email validation would block
                    before the request is ever sent. The server validates. */}
                <input
                  type="text"
                  inputMode="email"
                  autoCapitalize="none"
                  spellCheck={false}
                  required
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  className="w-full px-3 py-2 border border-ink/20 rounded font-mono text-sm"
                  autoComplete="username"
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
