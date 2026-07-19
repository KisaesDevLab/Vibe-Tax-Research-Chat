// Phase 4-26 — admin shell.
import { useState } from 'react';
import { Link, NavLink, Outlet } from 'react-router-dom';
import { useAuth } from '../../components/AuthProvider';
import { FontSizeSelector } from '../../components/ChatSidebar';

const navItems = [
  { to: '/admin', label: 'Dashboard', end: true },
  { to: '/admin/users', label: 'Users' },
  { to: '/admin/settings', label: 'Settings' },
  { to: '/admin/models', label: 'Models' },
  { to: '/admin/skills', label: 'Skills' },
  { to: '/admin/custom-skills', label: 'Custom skills' },
  { to: '/admin/references', label: 'References' },
  { to: '/admin/usage', label: 'Usage' },
  { to: '/admin/table-sets', label: 'Table sets' },
  { to: '/admin/review-queue', label: 'Review queue' },
];

export function AdminLayout() {
  const { user, logout } = useAuth();
  const [mobileNavOpen, setMobileNavOpen] = useState(false);
  const closeMobileNav = () => setMobileNavOpen(false);
  return (
    // h-dvh + overflow-hidden so the admin sidebar stays put and only the
    // content pane scrolls (matches the chat layout convention). h-dvh
    // tracks the visible viewport on iOS Safari so the bottom of the
    // content isn't hidden behind the URL bar. Mobile (<md): the nav is
    // an off-canvas drawer; md+: it's an inline 240px column.
    <div className="h-dvh overflow-hidden flex bg-paper">
      {/* Mobile-only backdrop. */}
      <div
        className={`fixed inset-0 z-20 bg-ink/30 md:hidden transition-opacity duration-200 ${
          mobileNavOpen ? 'opacity-100' : 'opacity-0 pointer-events-none'
        }`}
        onClick={closeMobileNav}
        aria-hidden
      />
      <aside
        className={`fixed inset-y-0 left-0 z-30 w-[240px] bg-paper border-r border-ink/10 p-4 flex flex-col overflow-y-auto transform transition-transform duration-200 md:static md:flex-none md:translate-x-0 ${
          mobileNavOpen ? 'translate-x-0' : '-translate-x-full md:translate-x-0'
        }`}
      >
        <div className="font-display text-lg mb-2">Vibe · Admin</div>
        <Link
          to="/research"
          onClick={closeMobileNav}
          className="text-xs text-ink/60 hover:text-ink underline mb-6"
          aria-label="Return to research"
        >
          ← Back to research
        </Link>
        <nav className="flex flex-col gap-1 text-sm">
          {navItems.map((n) => (
            <NavLink
              key={n.to}
              to={n.to}
              end={n.end}
              onClick={closeMobileNav}
              className={({ isActive }) =>
                `px-3 py-1.5 rounded ${isActive ? 'bg-ink text-paper' : 'hover:bg-ink/5'}`
              }
            >
              {n.label}
            </NavLink>
          ))}
        </nav>
        <div className="mt-auto text-xs text-ink/50 space-y-2">
          <FontSizeSelector />
          {/*
            Bull Board is mounted at /admin/queues outside the SPA. The
            auth middleware accepts the access token from either the
            Authorization header (SPA fetch path) OR a `vibe_at` cookie
            set at login. Plain link clicks send the cookie, so this
            <a> works without any handoff dance.
          */}
          <a href="/admin/queues" target="_blank" rel="noreferrer" className="underline block">
            Queues UI ↗
          </a>
          <div className="break-all">Signed in as {user?.email}</div>
          <button onClick={() => void logout()} className="underline">
            Sign out
          </button>
        </div>
      </aside>
      <main className="flex-1 h-full overflow-y-auto min-w-0">
        {/* Mobile-only top bar so the user can open the nav drawer. */}
        <header className="md:hidden sticky top-0 z-10 bg-paper border-b border-ink/10 px-4 py-3 flex items-center gap-3">
          <button
            type="button"
            onClick={() => setMobileNavOpen(true)}
            className="-ml-1 p-1 text-ink/70 hover:text-ink"
            aria-label="Open admin menu"
          >
            <svg
              width="22"
              height="22"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
              aria-hidden
            >
              <line x1="3" y1="6" x2="21" y2="6" />
              <line x1="3" y1="12" x2="21" y2="12" />
              <line x1="3" y1="18" x2="21" y2="18" />
            </svg>
          </button>
          <div className="font-display text-base">Vibe · Admin</div>
        </header>
        <div className="p-4 sm:p-6 md:p-8">
          <Outlet />
        </div>
      </main>
    </div>
  );
}
