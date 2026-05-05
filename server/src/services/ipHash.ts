const encoder = new TextEncoder();

export async function hashIp(ip: string): Promise<string> {
  const pepper = process.env.IP_HASH_PEPPER ?? '';
  const keyData = encoder.encode(pepper);
  const msgData = encoder.encode(ip);
  const key = await crypto.subtle.importKey('raw', keyData, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const sig = await crypto.subtle.sign('HMAC', key, msgData);
  return Buffer.from(sig).toString('hex');
}
