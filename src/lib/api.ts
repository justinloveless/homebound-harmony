// Thin fetch wrapper. Always sends cookies, parses JSON, throws on non-2xx.

const API_BASE = (import.meta.env.VITE_API_BASE as string | undefined) ?? '';

export class ApiError extends Error {
  constructor(
    public status: number,
    public body: unknown,
    message?: string,
    public needsAppUpdate?: boolean,
  ) {
    super(message ?? `Request failed (${status})`);
    this.name = 'ApiError';
  }
}

interface RequestOpts extends Omit<RequestInit, 'body'> {
  body?: unknown;
  rawBody?: BodyInit | null;
}

export async function api<T = unknown>(path: string, opts: RequestOpts = {}): Promise<T> {
  const { body, rawBody, headers, ...rest } = opts;

  const finalHeaders: Record<string, string> = {
    Accept: 'application/json',
    ...(headers as Record<string, string> | undefined),
  };

  let finalBody: BodyInit | null | undefined;
  if (rawBody !== undefined) {
    finalBody = rawBody;
  } else if (body !== undefined) {
    finalHeaders['Content-Type'] = finalHeaders['Content-Type'] ?? 'application/json';
    finalBody = JSON.stringify(body);
  }

  const res = await fetch(`${API_BASE}${path}`, {
    credentials: 'include',
    ...rest,
    headers: finalHeaders,
    body: finalBody,
  });

  // Some endpoints (logout) return 204 — handle bodyless responses.
  const text = await res.text();
  let parsed: unknown = null;
  if (text) {
    try { parsed = JSON.parse(text); } catch { parsed = text; }
  }

  if (!res.ok) {
    const msg = (parsed as any)?.error ?? `Request failed (${res.status})`;
    const needsAppUpdate = res.status === 410;
    if (needsAppUpdate && typeof window !== 'undefined') {
      window.dispatchEvent(
        new CustomEvent('app:update-required', { detail: parsed }),
      );
    }
    throw new ApiError(res.status, parsed, msg, needsAppUpdate);
  }
  return parsed as T;
}

api.get = <T>(path: string, opts?: RequestOpts) => api<T>(path, { ...opts, method: 'GET' });
api.post = <T>(path: string, body?: unknown, opts?: RequestOpts) => api<T>(path, { ...opts, method: 'POST', body });
api.put = <T>(path: string, body?: unknown, opts?: RequestOpts) => api<T>(path, { ...opts, method: 'PUT', body });
api.del = <T>(path: string, opts?: RequestOpts) => api<T>(path, { ...opts, method: 'DELETE' });

export function eventSource(path: string): EventSource {
  return new EventSource(`${API_BASE}${path}`, { withCredentials: true });
}
