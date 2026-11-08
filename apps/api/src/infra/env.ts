/**
 * Reads configuration from the environment. Errors name the variable but never echo its
 * value (rule 30).
 */

export function requiredEnv(name: string, env: NodeJS.ProcessEnv = process.env): string {
  const value = env[name];
  if (value === undefined || value.trim() === '') throw new Error(`${name} is not set`);
  return value;
}

/** A 32-byte secret given as base64 (generate with `openssl rand -base64 32`). */
export function secretKeyFromEnv(name: string, env: NodeJS.ProcessEnv = process.env): Buffer {
  const key = Buffer.from(requiredEnv(name, env), 'base64');
  if (key.length !== 32) throw new Error(`${name} must be 32 bytes, base64-encoded`);
  return key;
}

/** Comma-separated list, empty entries dropped. */
export function listEnv(name: string, env: NodeJS.ProcessEnv = process.env): string[] {
  return (env[name] ?? '')
    .split(',')
    .map((item) => item.trim())
    .filter((item) => item !== '');
}
