// TP-1 — top-level module shell: Research | Planning | Clients switcher.
// Owns the viewport (h-dvh); each module fills the remaining height via
// the min-h-0 outlet wrapper. Planning/Clients tabs render only when the
// planning module is enabled. The right-hand slot hosts the TP-2 active-
// client chip.
import { NavLink, Outlet } from 'react-router-dom';
import { useAppConfig } from '../lib/app-config';
import { useGoHotkeys } from '../lib/hotkeys';
import { ActiveClientProvider } from '../lib/active-client';
import { ActiveClientChip } from './ActiveClientChip';

const tabClass = ({ isActive }: { isActive: boolean }) =>
  `px-3 py-1 rounded text-sm ${isActive ? 'bg-ink text-paper' : 'text-ink/70 hover:bg-ink/5'}`;

export function AppShell() {
  const { config } = useAppConfig();
  useGoHotkeys({ planningEnabled: config.planning_enabled });

  return (
    <ActiveClientProvider>
      <div className="h-dvh flex flex-col bg-paper">
        <header className="flex items-center gap-1 px-3 py-1.5 border-b border-ink/10 shrink-0">
          <nav className="flex items-center gap-1" aria-label="Modules">
            <NavLink to="/research" className={tabClass}>
              Research
            </NavLink>
            {config.planning_enabled && (
              <>
                <NavLink to="/planning" className={tabClass}>
                  Planning
                </NavLink>
                <NavLink to="/clients" className={tabClass}>
                  Clients
                </NavLink>
              </>
            )}
          </nav>
          <div className="ml-auto flex items-center gap-2">
            {config.planning_enabled && <ActiveClientChip />}
          </div>
        </header>
        <div className="flex-1 min-h-0">
          <Outlet />
        </div>
      </div>
    </ActiveClientProvider>
  );
}
