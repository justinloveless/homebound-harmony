import React, { useEffect, useState } from 'react';
import { UpdateRequired } from '@/components/UpdateRequired';
import { APP_CLIENT_VERSION } from '@/lib/version';

const API_BASE = (import.meta.env.VITE_API_BASE as string | undefined) ?? '';

/** Compare dotted version strings (e.g. 2026.05.06.0). */
function isServerNewer(serverMin: string, client: string): boolean {
  if (!serverMin.trim()) return false;
  return serverMin.localeCompare(client, undefined, { numeric: true }) > 0;
}

export function AppUpdateGate({ children }: { children: React.ReactNode }) {
  const [blocked, setBlocked] = useState<{ detail?: unknown } | null>(null);

  useEffect(() => {
    const onRequired = (ev: Event) => {
      const ce = ev as CustomEvent<unknown>;
      setBlocked({ detail: ce.detail });
    };
    window.addEventListener('app:update-required', onRequired);
    return () => window.removeEventListener('app:update-required', onRequired);
  }, []);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch(`${API_BASE}/api/auth/me`, { credentials: 'include' });
        const min = res.headers.get('X-Min-Client-Version') ?? '';
        if (!cancelled && res.ok && isServerNewer(min, APP_CLIENT_VERSION)) {
          setBlocked({ detail: { minClientVersion: min } });
        }
      } catch {
        /* offline — ignore */
      }
    })();
    return () => { cancelled = true; };
  }, []);

  if (blocked) return <UpdateRequired detail={blocked.detail} />;
  return <>{children}</>;
}
