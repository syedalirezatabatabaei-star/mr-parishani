/**
 * Where to go after sign-in: only a path of this app (`/…`, not `//host` or `/\host`), so a
 * crafted link cannot send the visitor to another site (open redirect). Control characters,
 * which some browsers drop from a URL, are refused too.
 */
export function safeNext(value: string | string[] | undefined, fallback: string): string {
  if (typeof value !== 'string') return fallback;
  if (!value.startsWith('/') || value.startsWith('//') || value.startsWith('/\\')) return fallback;
  for (let i = 0; i < value.length; i++) if (value.charCodeAt(i) < 0x20) return fallback;
  return value;
}
