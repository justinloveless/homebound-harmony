import { hash, verify } from '@node-rs/argon2';

const ARGON2_OPTIONS = {
  memoryCost: 19456,
  timeCost: 2,
  outputLen: 32,
  parallelism: 1,
};

export async function hashPassword(password: string): Promise<string> {
  return hash(password, ARGON2_OPTIONS);
}

export async function verifyPassword(stored: string, password: string): Promise<boolean> {
  return verify(stored, password);
}

// AES-256-GCM encrypt/decrypt for TOTP secrets using server-side KEK.
function getKek(): ArrayBuffer {
  const kekHex = process.env.TOTP_KEK ?? '';
  if (kekHex.length !== 64) throw new Error('TOTP_KEK must be a 64-char hex string (32 bytes)');
  const bytes = Uint8Array.from(kekHex.match(/.{2}/g)!.map(b => parseInt(b, 16)));
  // Detach into its own ArrayBuffer so WebCrypto types don't complain about
  // a possibly-shared backing buffer.
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}

export async function encryptTotpSecret(secret: string): Promise<string> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const key = await crypto.subtle.importKey('raw', getKek(), { name: 'AES-GCM' }, false, ['encrypt']);
  const enc = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, new TextEncoder().encode(secret));
  const combined = new Uint8Array(12 + enc.byteLength);
  combined.set(iv, 0);
  combined.set(new Uint8Array(enc), 12);
  return Buffer.from(combined).toString('base64');
}

export async function decryptTotpSecret(encrypted: string): Promise<string> {
  const combined = Buffer.from(encrypted, 'base64');
  const iv = combined.subarray(0, 12);
  const ciphertext = combined.subarray(12);
  const key = await crypto.subtle.importKey('raw', getKek(), { name: 'AES-GCM' }, false, ['decrypt']);
  const dec = await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, key, ciphertext);
  return new TextDecoder().decode(dec);
}
