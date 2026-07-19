// TP-2 — app-level "active client" context. Per-user-SESSION persistence
// (FINAL master-plan decision): sessionStorage, keyed by user id, so the
// chip survives route changes within a tab but resets in a new tab and
// never leaks across users sharing a browser profile.
import {
  createContext,
  createElement,
  useCallback,
  useContext,
  useMemo,
  useState,
  type ReactNode,
} from 'react';
import { useAuth } from '../components/AuthProvider';

export interface ActiveClient {
  id: string;
  name: string;
}

interface ActiveClientContextValue {
  activeClient: ActiveClient | null;
  setActiveClient: (client: ActiveClient | null) => void;
}

const ActiveClientContext = createContext<ActiveClientContextValue>({
  activeClient: null,
  setActiveClient: () => undefined,
});

const storageKey = (userId: string) => `vibe.active-client.${userId}`;

function readStored(userId: string | undefined): ActiveClient | null {
  if (!userId) return null;
  try {
    const raw = sessionStorage.getItem(storageKey(userId));
    if (!raw) return null;
    const parsed = JSON.parse(raw) as ActiveClient;
    return parsed && typeof parsed.id === 'string' && typeof parsed.name === 'string'
      ? parsed
      : null;
  } catch {
    return null;
  }
}

export function ActiveClientProvider({ children }: { children: ReactNode }) {
  const { user } = useAuth();
  const userId = user?.id;
  // Lazy init + re-read when the signed-in user changes.
  const [state, setState] = useState<{ userId: string | undefined; client: ActiveClient | null }>(
    () => ({ userId, client: readStored(userId) }),
  );
  const client = state.userId === userId ? state.client : readStored(userId);

  const setActiveClient = useCallback(
    (next: ActiveClient | null) => {
      if (userId) {
        try {
          if (next) sessionStorage.setItem(storageKey(userId), JSON.stringify(next));
          else sessionStorage.removeItem(storageKey(userId));
        } catch {
          // Storage unavailable (private mode etc.) — chip still works in-memory.
        }
      }
      setState({ userId, client: next });
    },
    [userId],
  );

  const value = useMemo(
    () => ({ activeClient: client, setActiveClient }),
    [client, setActiveClient],
  );
  return createElement(ActiveClientContext.Provider, { value }, children);
}

export function useActiveClient(): ActiveClientContextValue {
  return useContext(ActiveClientContext);
}
