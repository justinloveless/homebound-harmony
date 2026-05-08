import { and, eq, isNull } from 'drizzle-orm';
import type { Context } from 'hono';
import { db } from '../db/client';
import { workspaceMembers } from '../db/schema';

export function canPostEvents(role: string): boolean {
  return role === 'owner' || role === 'admin' || role === 'editor';
}

export function canPutSnapshot(role: string): boolean {
  return canPostEvents(role);
}

export function canManageMembers(role: string): boolean {
  return role === 'owner' || role === 'admin';
}

export async function getActiveMembership(workspaceId: string, userId: string) {
  const rows = await db
    .select()
    .from(workspaceMembers)
    .where(
      and(
        eq(workspaceMembers.workspaceId, workspaceId),
        eq(workspaceMembers.userId, userId),
        isNull(workspaceMembers.revokedAt),
      ),
    )
    .limit(1);
  return rows[0] ?? null;
}

export type ResolvedWorkspace = { workspaceId: string; role: string };

/** Resolve workspace from `X-Workspace-Id` or the user's single active membership. */
export async function resolveWorkspace(c: Context, sessionUserId: string): Promise<ResolvedWorkspace | null> {
  const header = c.req.header('X-Workspace-Id')?.trim();
  if (header) {
    const m = await getActiveMembership(header, sessionUserId);
    if (!m) return null;
    return { workspaceId: m.workspaceId, role: m.role };
  }

  const rows = await db
    .select()
    .from(workspaceMembers)
    .where(and(eq(workspaceMembers.userId, sessionUserId), isNull(workspaceMembers.revokedAt)));

  if (rows.length === 0) return null;
  const pick =
    rows.length === 1
      ? rows[0]
      : [...rows].sort((a, b) => a.workspaceId.localeCompare(b.workspaceId))[0];
  return { workspaceId: pick.workspaceId, role: pick.role };
}

/** Same as resolveWorkspace but allows explicit workspace id from query (SSE). */
export async function resolveWorkspaceFromQuery(
  c: Context,
  sessionUserId: string,
): Promise<ResolvedWorkspace | null> {
  const q = c.req.query('workspaceId')?.trim();
  if (q) {
    const m = await getActiveMembership(q, sessionUserId);
    if (!m) return null;
    return { workspaceId: m.workspaceId, role: m.role };
  }
  return resolveWorkspace(c, sessionUserId);
}

export async function listActiveWorkspaceIdsForUser(userId: string): Promise<string[]> {
  const rows = await db
    .select({ workspaceId: workspaceMembers.workspaceId })
    .from(workspaceMembers)
    .where(and(eq(workspaceMembers.userId, userId), isNull(workspaceMembers.revokedAt)));
  return rows.map((r) => r.workspaceId);
}
