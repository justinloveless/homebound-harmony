/**
 * Long-lived server sessions for native clients (iOS): stay signed in across
 * restarts until explicit logout, app uninstall, or the absolute session cap.
 */
const TEN_YEARS_MS = Math.floor(10 * 365.25 * 24 * 60 * 60 * 1000);

/**
 * Hono enforces the cookie spec's 400-day Max-Age limit. Keep the browser/native
 * cookie sliding while the server-side session retains its longer absolute cap.
 */
const MAX_COOKIE_AGE_SEC = 400 * 24 * 60 * 60;

export const SESSION_ABSOLUTE_MS = TEN_YEARS_MS;
export const SESSION_IDLE_MS = TEN_YEARS_MS;
export const SESSION_COOKIE_MAX_AGE_SEC = MAX_COOKIE_AGE_SEC;
