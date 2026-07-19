// TP-3 — clients module route table (lazy-loaded behind RequirePlanning).
import { Routes, Route, Navigate } from 'react-router-dom';
import { ClientsPage } from './ClientsPage';
import { ClientDetailPage } from './ClientDetailPage';
import { ArchiveViewer } from './ArchiveViewer';

export default function ClientsModule() {
  return (
    <Routes>
      <Route index element={<ClientsPage />} />
      <Route path=":clientId/research/:archiveId" element={<ArchiveViewer />} />
      <Route path=":clientId/:tab?" element={<ClientDetailPage />} />
      <Route path="*" element={<Navigate to="." replace />} />
    </Routes>
  );
}
