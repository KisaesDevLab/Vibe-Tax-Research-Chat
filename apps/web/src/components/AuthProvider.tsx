// Phase 3 — auth context.
import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from 'react';
import type { AuthUser } from '@vibe/shared';
import { api, ApiError } from '../lib/api';
import { tokenStore } from '../lib/token-store';

/** What POST /api/auth/login and POST /api/auth/sso/exchange both return. */
export interface LoginResponse {
  access_token: string;
  refresh_token: string;
  user: AuthUser;
}

interface AuthCtx {
  user: AuthUser | null;
  loading: boolean;
  login: (email: string, password: string) => Promise<void>;
  /** Store a session some other call already minted (the SSO hand-off). */
  completeLogin: (r: LoginResponse) => void;
  logout: () => Promise<void>;
  refresh: () => Promise<void>;
}

const Ctx = createContext<AuthCtx | undefined>(undefined);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<AuthUser | null>(null);
  const [loading, setLoading] = useState(true);

  const refresh = useCallback(async () => {
    if (!tokenStore.getAccess()) {
      setUser(null);
      setLoading(false);
      return;
    }
    try {
      const me = await api<AuthUser>('/api/auth/me');
      setUser(me);
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) {
        tokenStore.clear();
      }
      setUser(null);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const completeLogin = useCallback((r: LoginResponse) => {
    tokenStore.set(r.access_token, r.refresh_token);
    setUser(r.user);
  }, []);

  const login = useCallback(
    async (email: string, password: string) => {
      const r = await api<LoginResponse>('/api/auth/login', {
        method: 'POST',
        body: JSON.stringify({ email, password }),
        skipRefresh: true,
      });
      completeLogin(r);
    },
    [completeLogin],
  );

  const logout = useCallback(async () => {
    try {
      await api('/api/auth/logout', {
        method: 'POST',
        body: JSON.stringify({ refresh_token: tokenStore.getRefresh() ?? '' }),
      });
    } catch {
      // ignore
    }
    tokenStore.clear();
    setUser(null);
  }, []);

  return (
    <Ctx.Provider value={{ user, loading, login, completeLogin, logout, refresh }}>
      {children}
    </Ctx.Provider>
  );
}

export function useAuth(): AuthCtx {
  const v = useContext(Ctx);
  if (!v) throw new Error('useAuth must be used within <AuthProvider>');
  return v;
}
