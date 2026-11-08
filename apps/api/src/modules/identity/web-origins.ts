import { listEnv } from '../../infra/env';

/**
 * WEB_ORIGINS, checked at start-up: without it every state-changing browser request
 * would be refused with 403, silently. Each entry must be a bare origin
 * (`https://app.example.ir`), exactly as browsers send it in the Origin header.
 */
export function webOriginsFromEnv(env: NodeJS.ProcessEnv = process.env): string[] {
  const origins = listEnv('WEB_ORIGINS', env);
  if (origins.length === 0) throw new Error('WEB_ORIGINS is not set');
  for (const origin of origins) {
    const parsed = URL.canParse(origin) ? new URL(origin) : null;
    if (
      parsed === null ||
      (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') ||
      parsed.origin !== origin
    ) {
      throw new Error('WEB_ORIGINS must list origins such as https://app.example.ir');
    }
  }
  return origins;
}
