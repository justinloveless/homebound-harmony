import { db } from '../db/client';
import { auditEvents } from '../db/schema';
import { hashIp } from './ipHash';

export type AuditAction =
  | 'login' | 'logout' | 'password_change' | 'recovery_used'
  | 'share_create' | 'share_revoke' | 'share_fetch' | 'totp_enroll';

export async function logEvent(params: {
  action: AuditAction;
  userId?: string;
  artifactId?: string;
  ip?: string;
  userAgent?: string;
}): Promise<void> {
  const ipHash = params.ip ? await hashIp(params.ip) : null;
  await db.insert(auditEvents).values({
    action: params.action,
    userId: params.userId ?? null,
    artifactId: params.artifactId ?? null,
    ipHash,
    userAgent: params.userAgent ?? null,
  });
}
