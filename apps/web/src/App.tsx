// Phase 1 — top-level routes. Real route gating is added in Phase 3 via <RequireRole>.
import { Routes, Route, Navigate } from 'react-router-dom';
import { LoginPage } from './pages/Login';
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
import { RequireAuth, RequireRole } from './components/RequireRole';

export function App() {
  return (
    <Routes>
      <Route path="/setup" element={<SetupPage />} />
      <Route path="/login" element={<LoginPage />} />

      <Route element={<RequireAuth />}>
        <Route path="/" element={<Navigate to="/chat" replace />} />
        <Route path="/chat" element={<ChatPage />} />
        <Route path="/chat/:chatId" element={<ChatPage />} />

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
          </Route>
        </Route>
      </Route>

      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  );
}
