import { TOTP, Secret } from 'otpauth';
import QRCode from 'qrcode';

export function generateTotpSecret(email: string): { secret: string; otpauth: string } {
  const totp = new TOTP({
    issuer: 'RouteCare',
    label: encodeURIComponent(email),
    algorithm: 'SHA1',
    digits: 6,
    period: 30,
    secret: new Secret({ size: 20 }),
  });
  return { secret: totp.secret.base32, otpauth: totp.toString() };
}

export function verifyTotpCode(secretBase32: string, code: string): boolean {
  const totp = new TOTP({
    algorithm: 'SHA1',
    digits: 6,
    period: 30,
    secret: Secret.fromBase32(secretBase32),
  });
  return totp.validate({ token: code, window: 1 }) !== null;
}

export async function generateQrDataUrl(otpauthUrl: string): Promise<string> {
  return QRCode.toDataURL(otpauthUrl);
}
