import type { MiddlewareHandler } from 'hono';
import type { TenantRole } from '../services/tenantContext';

/** Requires resolved tenant context (`requireTenant`) and one of the given roles. */
export function requireRole(...roles: TenantRole[]): MiddlewareHandler {
  return async (c, next) => {
    const role = (c as { get: (k: string) => unknown }).get('tenantRole') as TenantRole | undefined;
    if (!role || !roles.includes(role)) {
      return c.json({ error: 'Forbidden' }, 403);
    }
    await next();
  };
}
