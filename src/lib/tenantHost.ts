/** Must match server `APP_DOMAIN` for subdomain tenant routing. */
export const APP_DOMAIN =
  (import.meta.env.VITE_APP_DOMAIN as string | undefined)?.trim() || 'routecare.lovelesslabs.net';

/**
 * Separator between tenant slug and Coolify preview suffix when a tenant slug
 * is fused into a preview hostname. Mirrors the server constant in
 * `server/src/services/tenantContext.ts`.
 *
 *   production tenant: `<slug>.routecare.lovelesslabs.net`
 *   preview apex:      `pr-3-routecare.lovelesslabs.net`
 *   preview tenant:    `<slug>--pr-3-routecare.lovelesslabs.net`
 */
const PREVIEW_TENANT_SEPARATOR = '--';

function splitAppDomain(appDomain: string): { firstLabel: string; parent: string } | null {
  const dot = appDomain.indexOf('.');
  if (dot <= 0) return null;
  return { firstLabel: appDomain.slice(0, dot), parent: appDomain.slice(dot + 1) };
}

export type HostKind =
  | { kind: 'apex'; appHost: string }
  | { kind: 'tenant'; slug: string; appHost: string }
  | { kind: 'preview-apex'; appHost: string; previewId: string }
  | { kind: 'preview-tenant'; slug: string; appHost: string; previewId: string }
  | { kind: 'foreign' };

/**
 * Identify a hostname's role within the multi-tenant URL scheme.
 * `appHost` is the bare host that should be used to construct other URLs at
 * the same deployment level (production apex or preview apex).
 */
export function classifyHost(hostname: string, appDomain: string = APP_DOMAIN): HostKind {
  const h = hostname.toLowerCase().split(':')[0] ?? '';
  const d = appDomain.toLowerCase();
  if (!h) return { kind: 'foreign' };
  if (h === d || h === `www.${d}`) return { kind: 'apex', appHost: d };

  if (h.endsWith(`.${d}`)) {
    const sub = h.slice(0, -(d.length + 1));
    if (!sub || sub.includes('.')) return { kind: 'foreign' };
    const sep = sub.indexOf(PREVIEW_TENANT_SEPARATOR);
    const slug = sep > 0 ? sub.slice(0, sep) : sub;
    return { kind: 'tenant', slug, appHost: d };
  }

  const split = splitAppDomain(d);
  if (split) {
    const previewSuffix = `-${split.firstLabel}.${split.parent}`;
    if (h.endsWith(previewSuffix)) {
      const previewLabel = h.slice(0, -previewSuffix.length);
      if (previewLabel && !previewLabel.includes('.')) {
        const sep = previewLabel.indexOf(PREVIEW_TENANT_SEPARATOR);
        const previewId = sep > 0 ? previewLabel.slice(sep + PREVIEW_TENANT_SEPARATOR.length) : previewLabel;
        const appHost = `${previewId}-${split.firstLabel}.${split.parent}`;
        if (sep > 0) {
          return { kind: 'preview-tenant', slug: previewLabel.slice(0, sep), appHost, previewId };
        }
        return { kind: 'preview-apex', appHost, previewId };
      }
    }
  }

  return { kind: 'foreign' };
}

/** First DNS label tenant slug, or null on apex / preview-apex / foreign. */
export function parseTenantSlugFromHost(hostname: string): string | null {
  const c = classifyHost(hostname);
  return c.kind === 'tenant' || c.kind === 'preview-tenant' ? c.slug : null;
}

export type BrowserRegistrationHost = { kind: 'apex' } | { kind: 'tenant'; slug: string };

export function getBrowserRegistrationHost(): BrowserRegistrationHost {
  if (typeof window === 'undefined') return { kind: 'apex' };
  const slug = parseTenantSlugFromHost(window.location.hostname);
  return slug ? { kind: 'tenant', slug } : { kind: 'apex' };
}

/**
 * Build the hostname a tenant should use, mirroring the current host's
 * deployment level. On production this returns `<slug>.routecare.lovelesslabs.net`;
 * on a preview it returns `<slug>--pr-N-routecare.lovelesslabs.net`. Falls back
 * to the production form when called outside a browser or on a foreign host.
 */
export function buildTenantHostname(slug: string, hostname?: string, appDomain: string = APP_DOMAIN): string {
  const h = hostname ?? (typeof window !== 'undefined' ? window.location.hostname : '');
  const c = classifyHost(h, appDomain);
  if (c.kind === 'preview-apex' || c.kind === 'preview-tenant') {
    const split = splitAppDomain(appDomain);
    if (split) {
      return `${slug}${PREVIEW_TENANT_SEPARATOR}${c.previewId}-${split.firstLabel}.${split.parent}`;
    }
  }
  return `${slug}.${appDomain}`;
}

/**
 * Apex hostname for the current deployment ("routecare.lovelesslabs.net" on
 * production, "pr-N-routecare.lovelesslabs.net" on a preview). Useful for UI
 * copy that shows an example tenant URL pattern.
 */
export function getCurrentAppHost(hostname?: string, appDomain: string = APP_DOMAIN): string {
  const h = hostname ?? (typeof window !== 'undefined' ? window.location.hostname : '');
  const c = classifyHost(h, appDomain);
  if (c.kind === 'foreign') return appDomain;
  return c.appHost;
}
