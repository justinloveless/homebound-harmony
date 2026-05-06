import type { Context } from 'hono';
import { deleteCookie, setCookie } from 'hono/cookie';
import { SESSION_COOKIE_MAX_AGE_SEC } from './sessionConfig';

// `__Host-` cookies require Secure + Path=/ + no Domain. Outside production
// we drop the prefix so plain HTTP dev still works.
export const SECURE_COOKIES = process.env.NODE_ENV === 'production';
export const SESSION_COOKIE = SECURE_COOKIES ? '__Host-session' : 'session';

export function setSessionCookie(c: Context, sessionId: string): void {
  setCookie(c, SESSION_COOKIE, sessionId, {
    httpOnly: true,
    secure: SECURE_COOKIES,
    sameSite: 'Lax',
    path: '/',
    maxAge: SESSION_COOKIE_MAX_AGE_SEC,
  });
}

export function clearSessionCookie(c: Context): void {
  deleteCookie(c, SESSION_COOKIE, { path: '/' });
}
