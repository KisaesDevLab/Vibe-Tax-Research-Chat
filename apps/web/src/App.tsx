// Phase 1 — top-level routes. Real route gating is added in Phase 3 via <RequireRole>.
// TP-1 — module shell: /research | /planning | /clients under AppShell.
// Planning and Clients are lazy so their weight never lands in the
// research bundle; legacy /chat deep links redirect to /research.
import { lazy, Suspense } from 'react';
import { Routes, Route, Navigate } from 'react-router-dom';
import { LoginPage } from './pages/Login';
import { ForgotPasswordPage } from './pages/ForgotPassword';
import { ResetPasswordPage } from './pages/ResetPassword';
import { ChatPage } from './pages/Chat';
import { SetupPage } from './pages/Setup';
import { AdminLayout } from './pages/admin/AdminLayout';
import { AdminDashboard } from './pages/admin/Dashboard';
import { AdminUsersPage } from './pages/admin/Users';
import { AdminSettingsPage } from './pages/admin/Settings';
import { AdminModelsPage } from './pages/admin/Models';
import { AdminSkillsPage } from './pages/admin/Skills';
import { AdminCustomSkillsPage } from './pages/admin/CustomSkills';
import { AdminReferencesPage } from './pages/admin/References';
import { AdminUsagePage } from './pages/admin/Usage';
import { AdminBackupPage } from './pages/admin/Backup';
import { AdminTableSetsPage } from './pages/admin/TableSets';
import { AdminStrategiesPage } from './pages/admin/Strategies';
import { AdminReviewQueuePage } from './pages/admin/ReviewQueue';
import { RequireAuth, RequireRole } from './components/RequireRole';
import { RequirePlanning } from './components/RequirePlanning';
import { AppShell } from './components/AppShell';
import { LegacyChatRedirect } from './components/LegacyChatRedirect';

const PlanningModule = lazy(() => import('./modules/planning/index'));
const ClientsModule = lazy(() => import('./modules/clients/index'));

const lazyFallback = <div className="p-8 text-ink/60">Loading…</div>;

export function App() {
  return (
    <Routes>
      <Route path="/setup" element={<SetupPage />} />
      <Route path="/login" element={<LoginPage />} />
      <Route path="/forgot" element={<ForgotPasswordPage />} />
      <Route path="/reset" element={<ResetPasswordPage />} />

      <Route element={<RequireAuth />}>
        <Route element={<AppShell />}>
          <Route path="/" element={<Navigate to="/research" replace />} />
          <Route path="/research" element={<ChatPage />} />
          <Route path="/research/:chatId" element={<ChatPage />} />
          {/* Legacy deep links from before the module shell. */}
          <Route path="/chat" element={<Navigate to="/research" replace />} />
          <Route path="/chat/:chatId" element={<LegacyChatRedirect />} />

          <Route element={<RequirePlanning />}>
            <Route
              path="/planning/*"
              element={<Suspense fallback={lazyFallback}>{<PlanningModule />}</Suspense>}
            />
            <Route
              path="/clients/*"
              element={<Suspense fallback={lazyFallback}>{<ClientsModule />}</Suspense>}
            />
          </Route>
        </Route>

        <Route element={<RequireRole role="admin" />}>
          <Route path="/admin" element={<AdminLayout />}>
            <Route index element={<AdminDashboard />} />
            <Route path="users" element={<AdminUsersPage />} />
            <Route path="settings" element={<AdminSettingsPage />} />
            <Route path="models" element={<AdminModelsPage />} />
            <Route path="skills" element={<AdminSkillsPage />} />
            <Route path="custom-skills" element={<AdminCustomSkillsPage />} />
            <Route path="references" element={<AdminReferencesPage />} />
            <Route path="usage" element={<AdminUsagePage />} />
            <Route path="backup" element={<AdminBackupPage />} />
            <Route path="table-sets" element={<AdminTableSetsPage />} />
            <Route path="strategies" element={<AdminStrategiesPage />} />
            <Route path="review-queue" element={<AdminReviewQueuePage />} />
          </Route>
        </Route>
      </Route>

      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  );
}
