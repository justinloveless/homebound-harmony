import React, { createContext, useCallback, useContext, useEffect, useState } from 'react';
import { api, ApiError } from '@/lib/api';
import { derivePdk, unwrapKey } from '@/lib/crypto';

// Auth state machine. The WK never touches localStorage; on reload we
// re-derive it from password (`unlock`) once `/api/auth/me` confirms the
// session cookie is still valid.
export type AuthStatus =
  | 'checking'    // initial /api/auth/me call in flight
  | 'anonymous'   // no session — show /login or /register
  | 'locked'      // valid session, but we need password to unwrap WK
  | 'unlocked';   // WK in memory; app is usable

export interface AuthMe {
  id: string;
  email: string;
  pdkSalt: string;
  totpEnrolled: boolean;
  mfaDisabled?: boolean;
}

interface AuthContextValue {
  status: AuthStatus;
  me: AuthMe | null;
  workspaceKey: CryptoKey | null;
  login: (email: string, password: string, code?: string) => Promise<void>;
  unlock: (password: string) => Promise<void>;
  logout: () => Promise<void>;
  // After registration completes (and login finishes), this lets the
  // register page hand the WK over to the auth state without a fresh login.
  setUnlockedSession: (me: AuthMe, wk: CryptoKey) => void;
}

const AuthContext = createContext<AuthContextValue | null>(null);

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [status, setStatus] = useState<AuthStatus>('checking');
  const [me, setMe] = useState<AuthMe | null>(null);
  const [workspaceKey, setWorkspaceKey] = useState<CryptoKey | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const data = await api.get<AuthMe>('/api/auth/me');
        if (cancelled) return;
        setMe(data);
        setStatus('locked');
      } catch (err) {
        if (cancelled) return;
        if (err instanceof ApiError && err.status === 401) {
          setStatus('anonymous');
        } else {
          console.error('auth boot failed', err);
          setStatus('anonymous');
        }
      }
    })();
    return () => { cancelled = true; };
  }, []);

  const login = useCallback(async (email: string, password: string, code?: string) => {
    const { pdkSalt } = await api.post<{ pdkSalt: string }>('/api/auth/login', { email, password, code });
    const meData = await api.get<AuthMe>('/api/auth/me');
    const blob = await api.get<{ wrappedWorkspaceKey: string }>('/api/workspace');
    const pdk = await derivePdk(password, pdkSalt);
    const wk = await unwrapKey(blob.wrappedWorkspaceKey, pdk);
    setMe(meData);
    setWorkspaceKey(wk);
    setStatus('unlocked');
  }, []);

  const unlock = useCallback(async (password: string) => {
    if (!me) throw new Error('No session to unlock');
    const blob = await api.get<{ wrappedWorkspaceKey: string }>('/api/workspace');
    const pdk = await derivePdk(password, me.pdkSalt);
    let wk: CryptoKey;
    try {
      wk = await unwrapKey(blob.wrappedWorkspaceKey, pdk);
    } catch {
      throw new Error('Incorrect password');
    }
    setWorkspaceKey(wk);
    setStatus('unlocked');
  }, [me]);

  const logout = useCallback(async () => {
    try { await api.post('/api/auth/logout'); } catch { /* ignore */ }
    setMe(null);
    setWorkspaceKey(null);
    setStatus('anonymous');
  }, []);

  const setUnlockedSession = useCallback((meData: AuthMe, wk: CryptoKey) => {
    setMe(meData);
    setWorkspaceKey(wk);
    setStatus('unlocked');
  }, []);

  return (
    <AuthContext.Provider value={{ status, me, workspaceKey, login, unlock, logout, setUnlockedSession }}>
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth() {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be inside AuthProvider');
  return ctx;
}
