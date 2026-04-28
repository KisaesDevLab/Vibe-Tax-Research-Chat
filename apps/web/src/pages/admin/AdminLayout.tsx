// Phase 4-26 — admin shell.
import { NavLink, Outlet } from 'react-router-dom';
import { useAuth } from '../../components/AuthProvider';

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
    <div className="min-h-screen grid grid-cols-[240px_1fr] bg-paper">
      <aside className="border-r border-ink/10 p-4 flex flex-col">
        <div className="font-display text-lg mb-6">Vibe · Admin</div>
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
        <div className="mt-auto text-xs text-ink/50">
          <div className="mb-2">Signed in as {user?.email}</div>
          <button onClick={() => void logout()} className="underline">
            Sign out
          </button>
        </div>
      </aside>
      <main className="p-8">
        <Outlet />
      </main>
    </div>
  );
}
