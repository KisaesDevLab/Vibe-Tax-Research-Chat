// TP-6 — planning module router (lazy-loaded behind RequirePlanning).
import { Routes, Route, Navigate } from 'react-router-dom';
import { PlansListPage } from './PlansListPage';
import { PlanDetailPage } from './PlanDetailPage';

export default function PlanningModule() {
  return (
    <Routes>
      <Route index element={<PlansListPage />} />
      <Route path=":planId/:tab?" element={<PlanDetailPage />} />
      <Route path="*" element={<Navigate to="." replace />} />
    </Routes>
  );
}
