/** Platform operator allowlist from env `ADMIN_EMAILS` and optional `ADMIN_EMAIL`. */

function stripOuterQuotes(s: string): string {
  const t = s.trim();
  if (t.length >= 2) {
    if ((t.startsWith('"') && t.endsWith('"')) || (t.startsWith("'") && t.endsWith("'"))) {
      return t.slice(1, -1).trim();
    }
  }
  return t;
}

/** Raw list string from env (both vars; avoids a mistaken empty `ADMIN_EMAILS=` hiding `ADMIN_EMAIL`). */
function rawAdminListFromEnv(): string {
  const multi = process.env.ADMIN_EMAILS;
  const single = process.env.ADMIN_EMAIL;
  const chunks: string[] = [];
  if (multi != null && String(multi).trim() !== '') chunks.push(String(multi));
  if (single != null && String(single).trim() !== '') chunks.push(String(single));
  return chunks.join(',');
}

function normalizeEmailList(raw: string | undefined): Set<string> {
  const set = new Set<string>();
  if (!raw) return set;
  const cleaned = raw.replace(/^\uFEFF/, '').trim();
  if (!cleaned) return set;
  for (const part of cleaned.split(/[\n,;]+/)) {
    const e = stripOuterQuotes(part).toLowerCase();
    if (e) set.add(e);
  }
  return set;
}

/** Read env on each check so Docker/`bun --watch` picks up changes without relying on import-time snapshots. */
export function adminAllowlistSize(): number {
  return normalizeEmailList(rawAdminListFromEnv()).size;
}

export function isAdminEmail(email: string | undefined | null): boolean {
  if (!email) return false;
  const set = normalizeEmailList(rawAdminListFromEnv());
  return set.has(email.trim().toLowerCase());
}
