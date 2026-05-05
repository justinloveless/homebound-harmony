// `__Host-` cookies require Secure + Path=/ + no Domain. Outside production
// we drop the prefix so plain HTTP dev still works.
export const SECURE_COOKIES = process.env.NODE_ENV === 'production';
export const SESSION_COOKIE = SECURE_COOKIES ? '__Host-session' : 'session';
