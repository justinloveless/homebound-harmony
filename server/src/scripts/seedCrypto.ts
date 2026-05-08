/**
 * Subset of `src/lib/crypto.ts` for server-side seeds. Parameters must stay in
 * lockstep with the web client's Argon2id + AES-GCM envelope format.
 */
import { argon2id } from 'hash-wasm';

const enc = new TextEncoder();

const ARGON2_ITERATIONS = 3;
const ARGON2_MEMORY_KB = 64 * 1024;
const ARGON2_PARALLELISM = 1;
const ARGON2_KEY_LEN = 32;

export function bytesToBase64(bytes: Uint8Array): string {
  let bin = '';
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin);
}

export function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

export function hexToBytes(hex: string): Uint8Array {
  const clean = hex.replace(/\s+/g, '').toLowerCase();
  if (clean.length % 2 !== 0) throw new Error('Invalid hex length');
  const out = new Uint8Array(clean.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(clean.slice(i * 2, i * 2 + 2), 16);
  return out;
}

function base64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function randomBytes(n: number): Uint8Array {
  return crypto.getRandomValues(new Uint8Array(n));
}

async function deriveKeyBytes(password: string, saltB64: string): Promise<Uint8Array> {
  const salt = base64ToBytes(saltB64);
  const hashHex = await argon2id({
    password,
    salt,
    iterations: ARGON2_ITERATIONS,
    memorySize: ARGON2_MEMORY_KB,
    parallelism: ARGON2_PARALLELISM,
    hashLength: ARGON2_KEY_LEN,
    outputType: 'hex',
  });
  return hexToBytes(hashHex);
}

async function importAesKey(raw: Uint8Array, usages: KeyUsage[]): Promise<CryptoKey> {
  const copy = new Uint8Array(raw.byteLength);
  copy.set(raw);
  return crypto.subtle.importKey('raw', copy, { name: 'AES-GCM' }, false, usages);
}

async function derivePdk(password: string, saltB64: string): Promise<CryptoKey> {
  const raw = await deriveKeyBytes(password, saltB64);
  return importAesKey(raw, ['encrypt', 'decrypt', 'wrapKey', 'unwrapKey']);
}

async function generateWorkspaceKey(): Promise<CryptoKey> {
  return crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, true, ['encrypt', 'decrypt']);
}

async function exportRawKey(key: CryptoKey): Promise<Uint8Array> {
  const buf = await crypto.subtle.exportKey('raw', key);
  return new Uint8Array(buf);
}

export async function wrapKey(wk: CryptoKey, wrappingKey: CryptoKey): Promise<string> {
  const iv = randomBytes(12);
  const raw = await exportRawKey(wk);
  const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, wrappingKey, raw);
  const combined = new Uint8Array(iv.length + ct.byteLength);
  combined.set(iv, 0);
  combined.set(new Uint8Array(ct), iv.length);
  return bytesToBase64(combined);
}

export function normalizeRecoveryKey(input: string): string {
  return input.replace(/\s+/g, '').toLowerCase();
}

const RECOVERY_HASH_SALT_B64 = bytesToBase64(enc.encode('routecare-recovery-v1'));

export async function deriveRecoveryHash(recoveryKeyHex: string): Promise<string> {
  const raw = await deriveKeyBytes(normalizeRecoveryKey(recoveryKeyHex), RECOVERY_HASH_SALT_B64);
  return bytesToHex(raw);
}

async function deriveRecoveryWrappingKey(recoveryKeyHex: string, pdkSaltB64: string): Promise<CryptoKey> {
  const raw = await deriveKeyBytes(`rk:${normalizeRecoveryKey(recoveryKeyHex)}`, pdkSaltB64);
  return importAesKey(raw, ['encrypt', 'decrypt', 'wrapKey', 'unwrapKey']);
}

/** Fixed PDK salt for seeded accounts (16 bytes); compatible with `generatePdkSalt` layout. */
export const SEED_PDK_SALT_B64 = bytesToBase64(new Uint8Array(16).fill(0x5e));

/** 64-char hex recovery secret documented for ops / Apple review handoff. */
export const SEED_RECOVERY_KEY_HEX =
  '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';

export async function buildClientCompatibleWraps(password: string): Promise<{
  pdkSalt: string;
  recoveryKeyHash: string;
  wrappedWorkspaceKey: string;
  wrappedWorkspaceKeyRecovery: string;
}> {
  const pdkSalt = SEED_PDK_SALT_B64;
  const recoveryKey = SEED_RECOVERY_KEY_HEX;
  const wk = await generateWorkspaceKey();
  const pdk = await derivePdk(password, pdkSalt);
  const recoveryWrappingKey = await deriveRecoveryWrappingKey(recoveryKey, pdkSalt);
  const wrappedWorkspaceKey = await wrapKey(wk, pdk);
  const wrappedWorkspaceKeyRecovery = await wrapKey(wk, recoveryWrappingKey);
  const recoveryKeyHash = await deriveRecoveryHash(recoveryKey);
  return { pdkSalt, recoveryKeyHash, wrappedWorkspaceKey, wrappedWorkspaceKeyRecovery };
}
