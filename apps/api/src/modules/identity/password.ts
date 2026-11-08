import { hash, verify, Algorithm } from '@node-rs/argon2';

/**
 * argon2id (rule 25) with OWASP's recommended parameters: 19 MiB memory, 2 iterations,
 * 1 lane. The parameters are stored inside each hash, so raising them later still
 * verifies old hashes.
 */
const OPTIONS = {
  algorithm: Algorithm.Argon2id,
  memoryCost: 19_456,
  timeCost: 2,
  parallelism: 1,
} as const;

export function hashPassword(password: string): Promise<string> {
  return hash(password, OPTIONS);
}

/** Never throws on a malformed hash; that is simply a failed login. */
export async function verifyPassword(passwordHash: string, password: string): Promise<boolean> {
  try {
    return await verify(passwordHash, password);
  } catch {
    return false;
  }
}

/**
 * Verified against when the username does not exist, so a missing account takes as long
 * as a wrong password and response time does not reveal which usernames exist.
 */
let dummyHash: Promise<string> | undefined;
export function dummyPasswordHash(): Promise<string> {
  dummyHash ??= hashPassword('not-a-real-password-for-timing-only');
  return dummyHash;
}

/**
 * Task 9-3 (R13; ASVS 2.1.7): the obviously guessable passwords refused, from rules kept here
 * (no list fetched from outside, rules 17-18): the account's username in it, one character
 * repeated, digits only, a keyboard row, or a well-known password. The length floor
 * (`identity.staff_login.minPasswordLength`) is checked by the caller.
 */
const COMMON = [
  'password',
  'passw0rd',
  'qwerty',
  'qwertyuiop',
  'asdfghjkl',
  'zxcvbnm',
  'iloveyou',
  'admin',
  'administrator',
  'welcome',
  'letmein',
  'sepehr',
  'salamati',
  'arameshservat',
  '123456789',
  '1234567890',
  '0987654321',
  '1q2w3e4r',
  'abc123',
];
export function weakPasswordReason(password: string, username: string): string | null {
  const plain = password.toLowerCase().replace(/[\s_.-]/g, '');
  if (username.length >= 3 && plain.includes(username.toLowerCase()))
    return 'password_has_username';
  if (/^(.)\1+$/.test(plain)) return 'password_repeated';
  if (/^\d+$/.test(plain)) return 'password_digits_only';
  if (COMMON.some((c) => plain.includes(c) && plain.length - c.length <= 4))
    return 'password_common';
  return null;
}
