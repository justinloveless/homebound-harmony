/** Platform operator allowlist from env `ADMIN_EMAILS` (comma-separated). */

function normalizeEmailList(raw: string | undefined): Set<string> {
  const set = new Set<string>();
  if (!raw) return set;
  for (const part of raw.split(',')) {
    const e = part.trim().toLowerCase();
    if (e) set.add(e);
  }
  return set;
}

const adminEmails = normalizeEmailList(process.env.ADMIN_EMAILS);

export function isAdminEmail(email: string | undefined | null): boolean {
  if (!email) return false;
  return adminEmails.has(email.trim().toLowerCase());
}
