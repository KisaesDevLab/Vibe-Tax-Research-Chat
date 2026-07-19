// TP-1 — preserves pre-TP-1 deep links: /chat/:chatId → /research/:chatId.
// A plain <Navigate> can't interpolate route params, hence the component.
import { Navigate, useParams } from 'react-router-dom';

export function LegacyChatRedirect() {
  const { chatId } = useParams<{ chatId: string }>();
  return <Navigate to={chatId ? `/research/${chatId}` : '/research'} replace />;
}
