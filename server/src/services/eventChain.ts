import { createHash } from 'node:crypto';

/** Deterministic JSON for hash envelope (sorted object keys; arrays preserve order). */
export function canonicalJson(value: unknown): string {
  if (value === null) return 'null';
  const t = typeof value;
  if (t === 'number' || t === 'boolean') return JSON.stringify(value);
  if (t === 'string') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (t === 'object' && value !== null) {
    const o = value as Record<string, unknown>;
    const keys = Object.keys(o).sort();
    return `{${keys.map(k => `${JSON.stringify(k)}:${canonicalJson(o[k])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

export interface HashEnvelopeInput {
  userId: string;
  clientEventId: string;
  seq: number;
  serverReceivedAt: string;
  ipHash: string | null;
  gpsLat: number | null;
  gpsLon: number | null;
  gpsAccuracyM: number | null;
  gpsCapturedAt: string | null;
  isClinical: boolean;
  ciphertext: string;
  iv: string;
}

export function computeEventHash(prevHash: string, input: HashEnvelopeInput): string {
  const body = canonicalJson(input);
  return createHash('sha256').update(prevHash, 'utf8').update(body, 'utf8').digest('hex');
}
