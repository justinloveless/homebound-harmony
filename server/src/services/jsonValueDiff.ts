import { isDeepStrictEqual } from 'node:util';

export type PayloadDiffEntry = {
  path: string;
  kind: 'add' | 'remove' | 'change';
  before?: unknown;
  after?: unknown;
};

const MAX_STRING_PREVIEW = 240;

function preview(v: unknown): unknown {
  if (v === undefined) return undefined;
  if (typeof v === 'string') {
    if (v.length <= MAX_STRING_PREVIEW) return v;
    return `${v.slice(0, MAX_STRING_PREVIEW)}… (${v.length} chars)`;
  }
  if (typeof v === 'number' || typeof v === 'boolean' || v === null) return v;
  try {
    const s = JSON.stringify(v);
    if (s.length <= MAX_STRING_PREVIEW) return JSON.parse(s) as unknown;
    return `${s.slice(0, MAX_STRING_PREVIEW)}… (${s.length} chars JSON)`;
  } catch {
    return '[unserializable]';
  }
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v) && Object.getPrototypeOf(v) === Object.prototype;
}

function isCompositeValue(v: unknown): boolean {
  return Array.isArray(v) || isPlainObject(v);
}

function emptyCompositeLike(v: unknown): unknown {
  if (Array.isArray(v)) return [];
  if (isPlainObject(v)) return {};
  return undefined;
}

function hasIdArray(arr: unknown[]): arr is { id: string }[] {
  return arr.length === 0 || (typeof arr[0] === 'object' && arr[0] !== null && 'id' in (arr[0] as object));
}

export function diffJsonValues(before: unknown, after: unknown, basePath = ''): PayloadDiffEntry[] {
  if (isDeepStrictEqual(before, after)) return [];

  if (before === undefined && after !== undefined) {
    if (isCompositeValue(after)) return diffJsonValues(emptyCompositeLike(after), after, basePath);
    return [{ path: basePath || '.', kind: 'add', after: preview(after) }];
  }
  if (before !== undefined && after === undefined) {
    if (isCompositeValue(before)) return diffJsonValues(before, emptyCompositeLike(before), basePath);
    return [{ path: basePath || '.', kind: 'remove', before: preview(before) }];
  }

  if (before === null && isCompositeValue(after)) {
    return diffJsonValues(emptyCompositeLike(after), after, basePath);
  }
  if (isCompositeValue(before) && after === null) {
    return diffJsonValues(before, emptyCompositeLike(before), basePath);
  }

  if (before === null || after === null || typeof before !== typeof after) {
    return [{ path: basePath || '.', kind: 'change', before: preview(before), after: preview(after) }];
  }

  if (typeof before !== 'object' || typeof after !== 'object') {
    if (before !== after) return [{ path: basePath || '.', kind: 'change', before: preview(before), after: preview(after) }];
    return [];
  }

  if (Array.isArray(before) && Array.isArray(after)) {
    return diffArrays(before, after, basePath);
  }

  if (isPlainObject(before) && isPlainObject(after)) {
    return diffObjects(before, after, basePath);
  }

  return [{ path: basePath || '.', kind: 'change', before: preview(before), after: preview(after) }];
}

function diffObjects(
  a: Record<string, unknown>,
  b: Record<string, unknown>,
  basePath: string,
): PayloadDiffEntry[] {
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
  const out: PayloadDiffEntry[] = [];
  for (const k of keys) {
    const p = basePath ? `${basePath}.${k}` : k;
    if (!(k in a)) out.push(...diffJsonValues(undefined, b[k], p));
    else if (!(k in b)) out.push(...diffJsonValues(a[k], undefined, p));
    else out.push(...diffJsonValues(a[k], b[k], p));
  }
  return out;
}

function diffArrays(before: unknown[], after: unknown[], basePath: string): PayloadDiffEntry[] {
  if (hasIdArray(before) && hasIdArray(after)) {
    return diffArraysById(
      before as { id: string; [k: string]: unknown }[],
      after as { id: string; [k: string]: unknown }[],
      basePath,
    );
  }

  const out: PayloadDiffEntry[] = [];
  const len = Math.max(before.length, after.length);
  for (let i = 0; i < len; i++) {
    const p = `${basePath}[${i}]`;
    out.push(...diffJsonValues(before[i], after[i], p));
  }
  return out;
}

function diffArraysById(
  before: { id: string; [k: string]: unknown }[],
  after: { id: string; [k: string]: unknown }[],
  basePath: string,
): PayloadDiffEntry[] {
  const bm = new Map(before.map((x) => [x.id, x]));
  const am = new Map(after.map((x) => [x.id, x]));
  const ids = [...new Set([...bm.keys(), ...am.keys()])].sort();
  const out: PayloadDiffEntry[] = [];
  for (const id of ids) {
    const p = `${basePath}[id:${id}]`;
    const b = bm.get(id);
    const a = am.get(id);
    if (!b && a) out.push(...diffJsonValues(undefined, a, p));
    else if (b && !a) out.push(...diffJsonValues(b, undefined, p));
    else if (b && a) out.push(...diffJsonValues(b, a, p));
  }
  return out;
}

export function truncateDiffEntries(entries: PayloadDiffEntry[], max: number): {
  entries: PayloadDiffEntry[];
  truncated: boolean;
} {
  if (entries.length <= max) return { entries, truncated: false };
  return { entries: entries.slice(0, max), truncated: true };
}
