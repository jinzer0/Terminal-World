import { createHash, randomBytes, randomInt, randomUUID, scryptSync, timingSafeEqual } from 'node:crypto';

/**
 * 31-character unambiguous Crockford-like alphabet matching src/service/validation.ts.
 * Excludes I, L, O, 0, 1.
 */
export const UNBIGUOUS_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';

const SCRYPT_N = 16384;
const SCRYPT_R = 8;
const SCRYPT_P = 1;
const SCRYPT_KEYLEN = 64;

export function generateId(): string {
  return randomUUID();
}

export function sha256Hex(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

export function safeCompareHex(aHex: string, bHex: string): boolean {
  if (aHex.length !== bHex.length) return false;
  try {
    const a = Buffer.from(aHex, 'hex');
    const b = Buffer.from(bHex, 'hex');
    if (a.length !== b.length) return false;
    return timingSafeEqual(a, b);
  } catch {
    return false;
  }
}

export function hashPassword(password: string): string {
  const salt = randomBytes(16);
  const derived = scryptSync(password, salt, SCRYPT_KEYLEN, {
    N: SCRYPT_N,
    r: SCRYPT_R,
    p: SCRYPT_P,
  });
  return `scrypt$${SCRYPT_N}$${SCRYPT_R}$${SCRYPT_P}$${salt.toString('hex')}$${derived.toString('hex')}`;
}

export function verifyPassword(password: string, storedHash: string): boolean {
  const parts = storedHash.split('$');
  if (parts.length !== 6 || parts[0] !== 'scrypt') return false;
  const N = Number(parts[1]);
  const r = Number(parts[2]);
  const p = Number(parts[3]);
  const saltHex = parts[4];
  const expectedHex = parts[5];
  if (!Number.isFinite(N) || !Number.isFinite(r) || !Number.isFinite(p) || !saltHex || !expectedHex) {
    return false;
  }
  try {
    const salt = Buffer.from(saltHex, 'hex');
    const expected = Buffer.from(expectedHex, 'hex');
    const derived = scryptSync(password, salt, expected.length, { N, r, p });
    return derived.length === expected.length && timingSafeEqual(derived, expected);
  } catch {
    return false;
  }
}

export function generateRecoveryCode(): { raw: string; formatted: string } {
  let raw = '';
  for (let i = 0; i < 32; i += 1) {
    raw += UNBIGUOUS_ALPHABET[randomInt(0, UNBIGUOUS_ALPHABET.length)];
  }
  return { raw, formatted: formatRecoveryCode(raw) };
}

export function formatRecoveryCode(raw: string): string {
  const clean = raw.replaceAll('-', '').toUpperCase();
  const groups: string[] = [];
  for (let i = 0; i < clean.length; i += 4) {
    groups.push(clean.slice(i, i + 4));
  }
  return groups.join('-');
}

export function generateApprovalCode(): string {
  let code = '';
  for (let i = 0; i < 6; i += 1) {
    code += UNBIGUOUS_ALPHABET[randomInt(0, UNBIGUOUS_ALPHABET.length)];
  }
  return code;
}

export function generateToken(byteLength = 32): string {
  return randomBytes(byteLength).toString('base64url');
}

export function hashSecret(secret: string): string {
  return sha256Hex(secret);
}
