import { ForbiddenException } from '@nestjs/common';
import type { Actor } from '../audit/audit.port';
import type { ConfigPort } from '../config/config.port';

/**
 * Task 9-3 (R1; ASVS 3.7.1, 4.3.3; doc 04 §6): a sensitive action (roles, TOTP resets,
 * configuration) needs a TOTP code given again in this very session within the configured
 * window (`identity.reauth`), not just a session that is still open. Checked by the service
 * itself (rule 12), first, before anything is read or written.
 *
 * Actors without a session (the command line, server jobs) are not asked: they run on the
 * server by someone who already has it. Off while the key is disabled (until go-live, م۴).
 */
export async function assertFreshMfa(
  config: ConfigPort,
  actor: Actor,
  now = new Date(),
): Promise<void> {
  if (actor.sessionId === null) return;
  const { value } = await config.resolve('identity.reauth', {}, now);
  if (!value.enabled) return;
  const at = actor.reauthenticatedAt ?? null;
  const fresh =
    at !== null &&
    at.getTime() <= now.getTime() &&
    now.getTime() - at.getTime() <= value.windowSeconds * 1000;
  if (!fresh) throw new ForbiddenException({ error: 'reauth_required' });
}
