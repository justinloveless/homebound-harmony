import React, { createContext, useCallback, useContext, useEffect, useState } from 'react';
import { api, ApiError, setActiveWorkspaceId } from '@/lib/api';
import { unwrapWorkspaceKeyFromServerWrap } from '@/lib/crypto';

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
  isAdmin?: boolean;
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
  setUnlockedSession: (me: AuthMe, wk: CryptoKey, workspaceId?: string | null) => void;
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
    await api.post<{ pdkSalt: string }>('/api/auth/login', { email, password, code });
    const meData = await api.get<AuthMe>('/api/auth/me');
    const blob = await api.get<{ wrappedWorkspaceKey: string; workspaceId?: string }>('/api/snapshot');
    if (blob.workspaceId) setActiveWorkspaceId(blob.workspaceId);
    let wk: CryptoKey;
    try {
      wk = await unwrapWorkspaceKeyFromServerWrap(blob.wrappedWorkspaceKey, {
        password,
        pdkSalt: meData.pdkSalt,
      });
    } catch (e) {
      throw e instanceof Error ? e : new Error('Could not unlock workspace');
    }
    setMe(meData);
    setWorkspaceKey(wk);
    setStatus('unlocked');
  }, []);

  const unlock = useCallback(async (password: string) => {
    if (!me) throw new Error('No session to unlock');
    const blob = await api.get<{ wrappedWorkspaceKey: string; workspaceId?: string }>('/api/snapshot');
    if (blob.workspaceId) setActiveWorkspaceId(blob.workspaceId);
    let wk: CryptoKey;
    try {
      wk = await unwrapWorkspaceKeyFromServerWrap(blob.wrappedWorkspaceKey, {
        password,
        pdkSalt: me.pdkSalt,
      });
    } catch {
      throw new Error('Incorrect password or missing device key');
    }
    setWorkspaceKey(wk);
    setStatus('unlocked');
  }, [me]);

  const logout = useCallback(async () => {
    try { await api.post('/api/auth/logout'); } catch { /* ignore */ }
    setActiveWorkspaceId(null);
    setMe(null);
    setWorkspaceKey(null);
    setStatus('anonymous');
  }, []);

  const setUnlockedSession = useCallback((meData: AuthMe, wk: CryptoKey, workspaceId?: string | null) => {
    if (workspaceId) setActiveWorkspaceId(workspaceId);
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
