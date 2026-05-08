/** Email allowlist that disables MFA at login, sourced from env `MFA_DISABLED_EMAILS`.
 *
 * Intended for review accounts and tightly-scoped automated environments where
 * enrolling a TOTP authenticator would be impractical. Treat the env var as a
 * sensitive operational toggle: anyone listed here can sign in with just a
 * password. For real users, use the per-account `users.mfa_disabled` column. */

function stripOuterQuotes(s: string): string {
  const t = s.trim();
  if (t.length >= 2) {
    if ((t.startsWith('"') && t.endsWith('"')) || (t.startsWith("'") && t.endsWith("'"))) {
      return t.slice(1, -1).trim();
    }
  }
  return t;
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
export function isMfaDisabledEmail(email: string | undefined | null): boolean {
  if (!email) return false;
  const set = normalizeEmailList(process.env.MFA_DISABLED_EMAILS);
  return set.has(email.trim().toLowerCase());
}
