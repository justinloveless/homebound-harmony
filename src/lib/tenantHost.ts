/** Must match server `APP_DOMAIN` for subdomain tenant routing. */
export const APP_DOMAIN =
  (import.meta.env.VITE_APP_DOMAIN as string | undefined)?.trim() || 'routecare.lovelesslabs.net';

/** First label under APP_DOMAIN, or null on apex / www. */
export function parseTenantSlugFromHost(hostname: string): string | null {
  const h = hostname.toLowerCase().split(':')[0] ?? '';
  const d = APP_DOMAIN.toLowerCase();
  if (h === d || h === `www.${d}`) return null;
  if (h.endsWith(`.${d}`)) {
    const sub = h.slice(0, -(d.length + 1));
    if (sub && !sub.includes('.')) return sub;
  }
  return null;
}

export type BrowserRegistrationHost = { kind: 'apex' } | { kind: 'tenant'; slug: string };

export function getBrowserRegistrationHost(): BrowserRegistrationHost {
  if (typeof window === 'undefined') return { kind: 'apex' };
  const slug = parseTenantSlugFromHost(window.location.hostname);
  if (!slug) return { kind: 'apex' };
  return { kind: 'tenant', slug };
}
