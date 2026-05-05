import { describe, expect, test } from 'vitest';
import {
  decryptJson,
  derivePdk,
  deriveRecoveryWrappingKey,
  encryptJson,
  generatePdkSalt,
  generateRecoveryKey,
  generateWorkspaceKey,
  unwrapKey,
  wrapKey,
} from '@/lib/crypto';

// jsdom doesn't ship WebCrypto by default; use Node's globalThis.crypto.
import { webcrypto } from 'node:crypto';
if (!globalThis.crypto?.subtle) {
  Object.defineProperty(globalThis, 'crypto', { value: webcrypto });
}

describe('crypto round-trip', () => {
  test('encrypt/decrypt with workspace key', async () => {
    const wk = await generateWorkspaceKey();
    const blob = await encryptJson({ hello: 'world', n: 42 }, wk);
    const decoded = await decryptJson<{ hello: string; n: number }>(blob, wk);
    expect(decoded).toEqual({ hello: 'world', n: 42 });
  });

  test('PDK wrap/unwrap recovers the same WK', async () => {
    const salt = generatePdkSalt();
    const pdk = await derivePdk('correct horse battery staple', salt);
    const wk = await generateWorkspaceKey();

    const wrapped = await wrapKey(wk, pdk);
    const wk2 = await unwrapKey(wrapped, pdk);

    const blob = await encryptJson({ a: 1 }, wk);
    const decoded = await decryptJson<{ a: number }>(blob, wk2);
    expect(decoded).toEqual({ a: 1 });
  });

  test('wrong password fails to unwrap', async () => {
    const salt = generatePdkSalt();
    const wk = await generateWorkspaceKey();
    const pdkRight = await derivePdk('right-password', salt);
    const wrapped = await wrapKey(wk, pdkRight);

    const pdkWrong = await derivePdk('wrong-password', salt);
    await expect(unwrapKey(wrapped, pdkWrong)).rejects.toThrow();
  });

  test('recovery key envelope round-trips', async () => {
    const salt = generatePdkSalt();
    const wk = await generateWorkspaceKey();
    const recovery = generateRecoveryKey();

    const recWrap = await deriveRecoveryWrappingKey(recovery, salt);
    const wrapped = await wrapKey(wk, recWrap);
    const wk2 = await unwrapKey(wrapped, await deriveRecoveryWrappingKey(recovery, salt));

    const blob = await encryptJson({ ok: true }, wk);
    const decoded = await decryptJson<{ ok: boolean }>(blob, wk2);
    expect(decoded.ok).toBe(true);
  });
}, 60_000);
