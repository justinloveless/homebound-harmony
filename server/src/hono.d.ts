import type { users } from './db/schema';

declare module 'hono' {
  interface ContextVariableMap {
    userId: string;
    user: typeof users.$inferSelect;
    tenantId: string;
    tenantSlug: string;
    tenantRole: 'admin' | 'caregiver';
  }
}
