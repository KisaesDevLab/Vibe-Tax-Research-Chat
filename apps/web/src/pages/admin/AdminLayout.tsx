// Phase 4-26 — admin shell.
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
  { to: '/admin/usage', label: 'Usage' },
];

export function AdminLayout() {
  const { user, logout } = useAuth();
  return (
    // h-screen + overflow-hidden so the admin sidebar stays put and only
    // the content pane scrolls (matches the chat layout convention).
    <div className="h-screen overflow-hidden grid grid-cols-[240px_1fr] bg-paper">
      <aside className="h-full min-h-0 border-r border-ink/10 p-4 flex flex-col overflow-y-auto">
        <div className="font-display text-lg mb-2">Vibe · Admin</div>
        <Link
          to="/chat"
          className="text-xs text-ink/60 hover:text-ink underline mb-6"
          aria-label="Return to chat"
        >
          ← Back to chat
        </Link>
        <nav className="flex flex-col gap-1 text-sm">
          {navItems.map((n) => (
            <NavLink
              key={n.to}
              to={n.to}
              end={n.end}
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
          <div>Signed in as {user?.email}</div>
          <button onClick={() => void logout()} className="underline">
            Sign out
          </button>
        </div>
      </aside>
      <main className="h-full overflow-y-auto p-8">
        <Outlet />
      </main>
    </div>
  );
}
