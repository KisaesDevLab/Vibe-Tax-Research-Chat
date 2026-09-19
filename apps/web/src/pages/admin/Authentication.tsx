// Admin → Authentication (SSO / Vibe Auth): single sign-on mode, identity
// provider connection, group → role mapping and the break-glass status. The
// form is the shared @kisaesdevlab/vibe-auth component; this page supplies
// the session (the package speaks to GET/PUT /auth/settings with same-origin
// cookies, and our sessions are bearer tokens) and the Tailwind classes.
import { AuthSettingsPage } from '@kisaesdevlab/vibe-auth/react';
import { authedFetch } from '../../lib/api';
import { AUTH_BASE_PATH } from '../Login';

const inputCls = 'w-full px-3 py-2 border border-ink/20 rounded font-mono text-sm';
const btnCls =
  'px-3 py-1.5 border border-ink/20 rounded text-sm hover:bg-ink/5 disabled:opacity-50';

export function AdminAuthenticationPage() {
  return (
    <div>
      <h1 className="font-display text-3xl mb-6">Authentication</h1>
      <section className="border border-ink/10 rounded p-6 bg-white max-w-3xl">
        <h2 className="font-display text-xl mb-2">Single sign-on</h2>
        <p className="text-sm text-ink/60 mb-4">
          Sign researchers in through the firm&apos;s identity provider (Vibe Auth). Passwords keep
          working until the mode is set to <strong>SSO only</strong>; the break-glass account is
          provisioned from the server with{' '}
          <code className="text-xs">pnpm --filter @vibe/api vibe-auth breakglass ensure</code> and
          signs in at <code className="text-xs">/login/local</code>. See{' '}
          <code className="text-xs">docs/sso.md</code>.
        </p>
        <AuthSettingsPage
          basePath={AUTH_BASE_PATH}
          productName="Vibe Tax Research Chat"
          fetch={authedFetch}
          classNames={{
            root: 'grid gap-6 text-ink',
            section: 'grid gap-3 p-4 rounded border border-ink/10 bg-paper',
            label: 'grid gap-1 text-sm text-ink/80',
            input: inputCls,
            button: btnCls,
            buttonPrimary:
              'px-3 py-1.5 bg-ink text-paper rounded text-sm font-display tracking-wide disabled:opacity-50',
            buttonDanger:
              'px-3 py-1.5 bg-oxblood text-paper rounded text-sm font-display tracking-wide disabled:opacity-50',
            table: 'w-full text-sm',
            note: 'text-xs text-ink/60',
            error: 'text-sm text-oxblood',
          }}
        />
      </section>
    </div>
  );
}
