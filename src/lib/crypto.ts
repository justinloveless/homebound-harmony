// End-to-end encryption primitives for the web app.
//
// The server only ever sees ciphertext + wrapped keys; plaintext workspace
// data, recovery keys, and per-share keys never leave the user's device.
//
// Key hierarchy:
//   password ──Argon2id──▶ PDK ─wrap──▶ wrappedWorkspaceKey
//   recoveryKey ──Argon2id──▶ RDK ─wrap──▶ wrappedWorkspaceKeyRecovery
//   recoveryKey ──Argon2id (separate salt)──▶ recoveryKeyHash (server-side)
//   workspace plaintext ──AES-256-GCM(WK)──▶ ciphertext
//   share plaintext ──AES-256-GCM(per-artifact key)──▶ ciphertext

import { argon2id } from 'hash-wasm';

// ---- Encoding helpers ---------------------------------------------------

const enc = new TextEncoder();
const dec = new TextDecoder();

export function bytesToBase64(bytes: Uint8Array): string {
  let bin = '';
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin);
}

export function base64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes, b => b.toString(16).padStart(2, '0')).join('');
}

export function hexToBytes(hex: string): Uint8Array {
  const clean = hex.replace(/\s+/g, '').toLowerCase();
  if (clean.length % 2 !== 0) throw new Error('Invalid hex length');
  const out = new Uint8Array(clean.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(clean.slice(i * 2, i * 2 + 2), 16);
  return out;
}

function randomBytes(n: number): Uint8Array {
  return crypto.getRandomValues(new Uint8Array(n));
}

// ---- Argon2id (PDK / recovery-key derivation) ---------------------------

// Conservative interactive parameters: ~250ms on a modern laptop, gentle on
// phones. Tune up after measuring on the worst expected device.
const ARGON2_ITERATIONS = 3;
const ARGON2_MEMORY_KB = 64 * 1024; // 64 MiB
const ARGON2_PARALLELISM = 1;
const ARGON2_KEY_LEN = 32;

export function generatePdkSalt(): string {
  return bytesToBase64(randomBytes(16));
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
  // Copy into a standalone buffer — `raw.buffer` may be oversized (subarray/slice views),
  // which breaks `importKey` in Node/jsdom WebCrypto.
  const copy = new Uint8Array(raw.byteLength);
  copy.set(raw);
  return crypto.subtle.importKey('raw', copy, { name: 'AES-GCM' }, false, usages);
}

export async function derivePdk(password: string, saltB64: string): Promise<CryptoKey> {
  const raw = await deriveKeyBytes(password, saltB64);
  return importAesKey(raw, ['encrypt', 'decrypt', 'wrapKey', 'unwrapKey']);
}

// ---- Workspace key (WK) -------------------------------------------------

export async function generateWorkspaceKey(): Promise<CryptoKey> {
  return crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, true, ['encrypt', 'decrypt']);
}

async function exportRawKey(key: CryptoKey): Promise<Uint8Array> {
  const buf = await crypto.subtle.exportKey('raw', key);
  return new Uint8Array(buf);
}

async function importRawKey(raw: Uint8Array): Promise<CryptoKey> {
  return importAesKey(raw, ['encrypt', 'decrypt']);
}

// Envelope: base64(iv(12) || aes-gcm(wrappingKey, raw WK))
export async function wrapKey(wk: CryptoKey, wrappingKey: CryptoKey): Promise<string> {
  const iv = randomBytes(12);
  const raw = await exportRawKey(wk);
  const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, wrappingKey, raw);
  return packIvCiphertext(iv, new Uint8Array(ct));
}

export async function unwrapKey(envelope: string, wrappingKey: CryptoKey): Promise<CryptoKey> {
  const { iv, ciphertext } = unpackIvCiphertext(envelope);
  const raw = await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, wrappingKey, ciphertext);
  return importRawKey(new Uint8Array(raw));
}

function packIvCiphertext(iv: Uint8Array, ct: Uint8Array): string {
  const combined = new Uint8Array(iv.length + ct.length);
  combined.set(iv, 0);
  combined.set(ct, iv.length);
  return bytesToBase64(combined);
}

function unpackIvCiphertext(b64: string): { iv: Uint8Array; ciphertext: Uint8Array } {
  const all = base64ToBytes(b64);
  return { iv: all.slice(0, 12), ciphertext: all.slice(12) };
}

// ---- Workspace blob encryption -----------------------------------------

export interface EncryptedBlob {
  ciphertext: string; // base64
  iv: string;         // base64
}

export async function encryptJson(value: unknown, key: CryptoKey): Promise<EncryptedBlob> {
  const iv = randomBytes(12);
  const plaintext = enc.encode(JSON.stringify(value));
  const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, plaintext);
  return { ciphertext: bytesToBase64(new Uint8Array(ct)), iv: bytesToBase64(iv) };
}

export async function decryptJson<T>(blob: EncryptedBlob, key: CryptoKey): Promise<T> {
  const iv = base64ToBytes(blob.iv);
  const ct = base64ToBytes(blob.ciphertext);
  const pt = await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, key, ct);
  return JSON.parse(dec.decode(pt)) as T;
}

// ---- Recovery key (24-word style hex) ----------------------------------

// Plain hex is used in the wire format (32 bytes → 64 hex chars). For
// display we group it into 4-char chunks so it's tolerable to type back.
export function generateRecoveryKey(): string {
  return bytesToHex(randomBytes(32));
}

export function formatRecoveryKey(hex: string): string {
  const clean = hex.replace(/\s+/g, '').toLowerCase();
  return clean.match(/.{1,4}/g)?.join(' ') ?? clean;
}

export function normalizeRecoveryKey(input: string): string {
  return input.replace(/\s+/g, '').toLowerCase();
}

// Server stores recoveryKeyHash = Argon2id(recoveryKey, fixed app salt).
// The salt is constant so anyone with the recovery key (and the email) can
// reproduce the hash; that's fine because the server already gates by email.
const RECOVERY_HASH_SALT_B64 = bytesToBase64(enc.encode('routecare-recovery-v1'));

export async function deriveRecoveryHash(recoveryKeyHex: string): Promise<string> {
  const raw = await deriveKeyBytes(normalizeRecoveryKey(recoveryKeyHex), RECOVERY_HASH_SALT_B64);
  return bytesToHex(raw);
}

// Wrapping key derived from recovery key, used to wrap/unwrap WK.
export async function deriveRecoveryWrappingKey(recoveryKeyHex: string, pdkSaltB64: string): Promise<CryptoKey> {
  // Reusing the user's pdk salt keeps the per-user derivation domain-separated
  // without needing a second salt column.
  const raw = await deriveKeyBytes('rk:' + normalizeRecoveryKey(recoveryKeyHex), pdkSaltB64);
  return importAesKey(raw, ['encrypt', 'decrypt', 'wrapKey', 'unwrapKey']);
}

// ---- Per-share artifact keys -------------------------------------------

export async function generateShareKey(): Promise<CryptoKey> {
  return crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, true, ['encrypt', 'decrypt']);
}

export async function exportShareKeyAsHex(key: CryptoKey): Promise<string> {
  return bytesToHex(await exportRawKey(key));
}

export async function importShareKeyFromHex(hex: string): Promise<CryptoKey> {
  return importRawKey(hexToBytes(hex));
}
