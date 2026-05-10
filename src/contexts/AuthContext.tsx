import React, { useCallback, useContext, useEffect, useState } from 'react';
import { api, setActiveTenantId, ApiError } from '@/lib/api';
import { parseTenantSlugFromHost } from '@/lib/tenantHost';

export type AuthStatus = 'checking' | 'anonymous' | 'authenticated';

export interface TenantInfo {
  id: string;
  slug: string;
  name: string;
  role: string;
}

export interface AuthMe {
  id: string;
  email: string;
  tenants: TenantInfo[];
  totpEnrolled: boolean;
  mfaDisabled?: boolean;
  isAdmin?: boolean;
}

interface AuthContextValue {
  status: AuthStatus;
  me: AuthMe | null;
  activeTenantId: string | null;
  setActiveTenant: (tenantId: string) => void;
  login: (email: string, password: string, code?: string) => Promise<void>;
  logout: () => Promise<void>;
}

const AuthContext = React.createContext<AuthContextValue | null>(null);

function pickDefaultTenant(tenants: TenantInfo[]): string | null {
  if (tenants.length === 0) return null;
  if (typeof window !== 'undefined') {
    const slug = parseTenantSlugFromHost(window.location.hostname);
    if (slug) {
      const match = tenants.find((t) => t.slug === slug);
      if (match) return match.id;
    }
  }
  return tenants[0].id;
}

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [status, setStatus] = useState<AuthStatus>('checking');
  const [me, setMe] = useState<AuthMe | null>(null);
  const [activeTenantId, setActiveTenantIdState] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const data = await api.get<AuthMe>('/api/auth/me');
        if (cancelled) return;
        setMe(data);
        const tid = pickDefaultTenant(data.tenants);
        setActiveTenantId(tid);
        setActiveTenantIdState(tid);
        setStatus('authenticated');
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
    return () => {
      cancelled = true;
    };
  }, []);

  const setActiveTenant = useCallback((tenantId: string) => {
    setActiveTenantId(tenantId);
    setActiveTenantIdState(tenantId);
  }, []);

  const login = useCallback(async (email: string, password: string, code?: string) => {
    await api.post('/api/auth/login', { email, password, code });
    const meData = await api.get<AuthMe>('/api/auth/me');
    setMe(meData);
    const tid = pickDefaultTenant(meData.tenants);
    setActiveTenantId(tid);
    setActiveTenantIdState(tid);
    setStatus('authenticated');
  }, []);

  const logout = useCallback(async () => {
    try {
      await api.post('/api/auth/logout');
    } catch {
      /* ignore */
    }
    setActiveTenantId(null);
    setMe(null);
    setActiveTenantIdState(null);
    setStatus('anonymous');
  }, []);

  return (
    <AuthContext.Provider
      value={{
        status,
        me,
        activeTenantId,
        setActiveTenant,
        login,
        logout,
      }}
    >
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth() {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be inside AuthProvider');
  return ctx;
}
