import { and, eq, isNull } from 'drizzle-orm';
import type { Context, MiddlewareHandler } from 'hono';
import { db } from '../db/client';
import { tenants, tenantMembers } from '../db/schema';

export type TenantRole = 'admin' | 'caregiver';

export type ResolvedTenant = {
  tenantId: string;
  tenantSlug: string;
  role: TenantRole;
};

export const APP_DOMAIN = process.env.APP_DOMAIN ?? 'routecare.lovelesslabs.net';

/**
 * Separator between tenant slug and Coolify preview suffix when a tenant slug
 * is fused into a preview hostname (single-label workaround for nested
 * wildcard DNS / cert limitations).
 *
 *   production tenant: `<slug>.routecare.lovelesslabs.net`
 *   preview apex:      `pr-3-routecare.lovelesslabs.net`
 *   preview tenant:    `<slug>--pr-3-routecare.lovelesslabs.net`
 */
const PREVIEW_TENANT_SEPARATOR = '--';

/**
 * Extract the tenant slug from `host`. Handles both the canonical
 * `<slug>.APP_DOMAIN` form and the Coolify preview form where the preview ID
 * and APP_DOMAIN's first label are fused into a single DNS label
 * (`<slug>--pr-N-routecare.lovelesslabs.net`). Returns null for apex hosts,
 * preview-apex hosts, and anything that doesn't belong to APP_DOMAIN's zone.
 */
function parseSubdomain(host: string, appDomain: string): string | null {
  const h = host.split(':')[0]?.toLowerCase() ?? '';
  const d = appDomain.toLowerCase();
  if (h === d || h === `www.${d}`) return null;

  if (h.endsWith(`.${d}`)) {
    const sub = h.slice(0, -(d.length + 1));
    if (!sub || sub.includes('.')) return null;
    const sep = sub.indexOf(PREVIEW_TENANT_SEPARATOR);
    return sep > 0 ? sub.slice(0, sep) : sub;
  }

  const dot = d.indexOf('.');
  if (dot > 0) {
    const firstLabel = d.slice(0, dot);
    const parent = d.slice(dot + 1);
    const previewSuffix = `-${firstLabel}.${parent}`;
    if (h.endsWith(previewSuffix)) {
      const previewLabel = h.slice(0, -previewSuffix.length);
      if (previewLabel && !previewLabel.includes('.')) {
        const sep = previewLabel.indexOf(PREVIEW_TENANT_SEPARATOR);
        if (sep > 0) return previewLabel.slice(0, sep);
      }
    }
  }

  return null;
}

/**
 * Build the tenant hostname appropriate for the current request, mirroring
 * production vs. preview deployments. On production it returns
 * `<slug>.routecare.lovelesslabs.net`; on a preview it returns
 * `<slug>--pr-N-routecare.lovelesslabs.net`.
 */
export function buildTenantHost(slug: string, requestHost: string, appDomain: string = APP_DOMAIN): string {
  const h = requestHost.split(':')[0]?.toLowerCase() ?? '';
  const d = appDomain.toLowerCase();
  const dot = d.indexOf('.');
  if (dot > 0) {
    const firstLabel = d.slice(0, dot);
    const parent = d.slice(dot + 1);
    const previewSuffix = `-${firstLabel}.${parent}`;
    if (h.endsWith(previewSuffix)) {
      const previewLabel = h.slice(0, -previewSuffix.length);
      if (previewLabel && !previewLabel.includes('.')) {
        const sep = previewLabel.indexOf(PREVIEW_TENANT_SEPARATOR);
        const previewId = sep > 0 ? previewLabel.slice(sep + PREVIEW_TENANT_SEPARATOR.length) : previewLabel;
        return `${slug}${PREVIEW_TENANT_SEPARATOR}${previewId}-${firstLabel}.${parent}`;
      }
    }
  }
  return `${slug}.${appDomain}`;
}

export type RegistrationHostResolution =
  | { status: 'apex' }
  | { status: 'unknown_slug'; slug: string }
  | { status: 'ok'; tenantId: string; tenantSlug: string };

/**
 * For public registration: resolve tenant from Host subdomain only (no membership check).
 */
export async function resolveRegistrationTenantFromHost(c: {
  req: { header: (n: string) => string | undefined };
}): Promise<RegistrationHostResolution> {
  const host = c.req.header('host') ?? '';
  const fromSub = parseSubdomain(host, APP_DOMAIN);
  if (fromSub) {
    const rows = await db.select({ id: tenants.id, slug: tenants.slug }).from(tenants).where(eq(tenants.slug, fromSub)).limit(1);
    if (!rows[0]) return { status: 'unknown_slug', slug: fromSub };
    return { status: 'ok', tenantId: rows[0].id, tenantSlug: rows[0].slug };
  }

  const devSlug =
    process.env.NODE_ENV !== 'production'
      ? process.env.REGISTRATION_FALLBACK_TENANT_SLUG?.trim().toLowerCase()
      : undefined;
  if (devSlug) {
    const rows = await db.select({ id: tenants.id, slug: tenants.slug }).from(tenants).where(eq(tenants.slug, devSlug)).limit(1);
    if (!rows[0]) return { status: 'unknown_slug', slug: devSlug };
    return { status: 'ok', tenantId: rows[0].id, tenantSlug: rows[0].slug };
  }

  return { status: 'apex' };
}

/** Resolve tenant from query `tenantId`, Host subdomain, `X-Tenant-Id` / `X-Tenant-Slug`, or first membership. */
export async function resolveTenantForRequest(c: Context, userId: string): Promise<ResolvedTenant | null> {
  const queryTenantId = c.req.query('tenantId')?.trim();

  const host = c.req.header('host') ?? '';
  const fromSub = parseSubdomain(host, APP_DOMAIN);
  const headerTenantId = c.req.header('X-Tenant-Id')?.trim();
  const headerSlug = c.req.header('X-Tenant-Slug')?.trim();

  let tenantId: string | null = null;
  let tenantSlug: string | null = null;

  if (queryTenantId) {
    const rows = await db.select({ id: tenants.id, slug: tenants.slug }).from(tenants).where(eq(tenants.id, queryTenantId)).limit(1);
    if (!rows[0]) return null;
    tenantId = rows[0].id;
    tenantSlug = rows[0].slug;
  } else if (fromSub) {
    const rows = await db.select({ id: tenants.id, slug: tenants.slug }).from(tenants).where(eq(tenants.slug, fromSub)).limit(1);
    if (!rows[0]) return null;
    tenantId = rows[0].id;
    tenantSlug = rows[0].slug;
  } else if (headerTenantId) {
    const rows = await db.select({ id: tenants.id, slug: tenants.slug }).from(tenants).where(eq(tenants.id, headerTenantId)).limit(1);
    if (!rows[0]) return null;
    tenantId = rows[0].id;
    tenantSlug = rows[0].slug;
  } else if (headerSlug) {
    const rows = await db.select({ id: tenants.id, slug: tenants.slug }).from(tenants).where(eq(tenants.slug, headerSlug)).limit(1);
    if (!rows[0]) return null;
    tenantId = rows[0].id;
    tenantSlug = rows[0].slug;
  } else {
    const rows = await db
      .select({
        id: tenants.id,
        slug: tenants.slug,
        role: tenantMembers.role,
      })
      .from(tenantMembers)
      .innerJoin(tenants, eq(tenantMembers.tenantId, tenants.id))
      .where(and(eq(tenantMembers.userId, userId), isNull(tenantMembers.revokedAt)))
      .limit(1);
    if (!rows[0]) return null;
    tenantId = rows[0].id;
    tenantSlug = rows[0].slug;
    const role = rows[0].role === 'admin' ? 'admin' : 'caregiver';
    return { tenantId, tenantSlug, role };
  }

  const m = await db
    .select({ role: tenantMembers.role })
    .from(tenantMembers)
    .where(
      and(eq(tenantMembers.tenantId, tenantId!), eq(tenantMembers.userId, userId), isNull(tenantMembers.revokedAt)),
    )
    .limit(1);
  if (!m[0]) return null;
  const role = m[0].role === 'admin' ? 'admin' : 'caregiver';
  return { tenantId: tenantId!, tenantSlug: tenantSlug!, role };
}

export const requireTenant: MiddlewareHandler = async (c, next) => {
  const userId = (c as { get: (k: string) => unknown }).get('userId') as string | undefined;
  if (!userId) return c.json({ error: 'Unauthorized' }, 401);

  const t = await resolveTenantForRequest(c, userId);
  if (!t) return c.json({ error: 'Tenant not found or access denied' }, 404);

  (c as { set: (k: string, v: unknown) => void }).set('tenantId', t.tenantId);
  (c as { set: (k: string, v: unknown) => void }).set('tenantSlug', t.tenantSlug);
  (c as { set: (k: string, v: unknown) => void }).set('tenantRole', t.role);
  await next();
};
