import {
  ForbiddenException,
  Inject,
  Injectable,
  UnauthorizedException,
  type CanActivate,
  type ExecutionContext,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Request } from 'express';
import { ACCESS_PORT, type AccessPort, type EffectiveAccess } from '../../common/auth/access.port';
import {
  ACCESS_METADATA,
  MOBILE_EXEMPT_METADATA,
  type AccessRule,
  type AuthenticatedRequest,
} from '../../common/auth/auth.decorators';
import { IDENTITY_SECRETS, type IdentitySecrets } from './identity.tokens';
import type { Redis } from 'ioredis';
import { CONFIG, type ConfigPort } from '../../common/config/config.port';
import { REDIS } from '../../infra/redis.module';
import { tooManyRequests } from './otp-login.service';
import { RateLimiter } from './rate-limiter';
import { SessionService } from './session.service';
import { staffMobileRequired } from './staff-mobile';
import { safeEqual } from './tokens';
import { bearerToken, CSRF_HEADER, isSafeMethod, sessionCookie } from './web';

/**
 * Global guard. Denies by default (rule 11):
 *
 * - `@Public()`: anyone. A browser request from a foreign origin is still refused
 *   (login CSRF).
 * - otherwise a valid session is required: `Authorization: Bearer` (mobile) or the
 *   `__Host-sid` cookie (web). Cookie requests that change state must come from an
 *   allowed origin and carry the session's CSRF token.
 * - a staff session is refused outside the internal panel's IP allow-list, when that
 *   policy is enabled (doc 04 §6).
 * - a `mfa_pending` session only reaches `@AllowPendingMfa()` endpoints.
 * - `@SelfService()` / `@AllowPendingMfa()`: any such session.
 * - an internal staff member without a proved mobile reaches only `@AllowWithoutMobile()`
 *   endpoints while `identity.staff_mobile_required` is on (task 9-3, owner's question 3).
 * - `@RequirePermission(code)`: the caller's roles, resolved now, must include the code.
 *   The resolved access is attached to the request for the service's scope checks.
 * - `@RequireAnyPermission(...codes)`: the same, with at least one of the codes.
 * - anything else: 403 (the API does not even start with such an endpoint).
 */
@Injectable()
export class AuthGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly sessions: SessionService,
    @Inject(IDENTITY_SECRETS) private readonly secrets: IdentitySecrets,
    @Inject(ACCESS_PORT) private readonly access: AccessPort,
    @Inject(CONFIG) private readonly config: ConfigPort,
    @Inject(REDIS) redis: Redis,
  ) {
    this.limiter = new RateLimiter(redis);
  }

  private readonly limiter: RateLimiter;

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const rule = this.reflector.getAllAndOverride<AccessRule | undefined>(ACCESS_METADATA, [
      context.getHandler(),
      context.getClass(),
    ]);
    const req = context.switchToHttp().getRequest<Request & AuthenticatedRequest>();

    const origin = req.headers.origin;
    if (
      origin !== undefined &&
      !isSafeMethod(req.method) &&
      !this.secrets.webOrigins.includes(origin)
    ) {
      throw new ForbiddenException({ error: 'origin_not_allowed' });
    }
    if (rule === 'public') {
      // Task 9-3 (R5): anyone may call it, nobody without end.
      const { value } = await this.config.resolve('identity.public_rate_limit');
      const hit = await this.limiter.hit(`public:${req.ip ?? 'unknown'}`, value.perIpPerMinute, 60);
      if (!hit.allowed) throw tooManyRequests('rate_limited', hit.retryAfterSeconds);
      return true;
    }

    const bearer = bearerToken(req);
    const cookie = bearer === null ? sessionCookie(req) : null;
    const token = bearer ?? cookie;
    if (token === null) throw new UnauthorizedException({ error: 'not_authenticated' });

    const auth = await this.sessions.authenticate(token, bearer !== null ? 'mobile' : 'web');
    if (!auth) throw new UnauthorizedException({ error: 'not_authenticated' });

    if (auth.client === 'web' && !isSafeMethod(req.method)) {
      const sent = req.headers[CSRF_HEADER];
      if (
        origin === undefined ||
        typeof sent !== 'string' ||
        !safeEqual(sent, this.sessions.csrfToken(auth.sessionId))
      ) {
        throw new ForbiddenException({ error: 'csrf_check_failed' });
      }
    }

    // The internal panel's network limit (doc 04 §6) holds for internal roles only, never for
    // center staff working from their clinics (owner, task 2-11): an internal account, or any
    // account holding a role with an internal scope (global, city, queue). By role, not only by
    // account kind, so a center account given an internal role is limited too.
    let access: EffectiveAccess | null = null;
    if (auth.kind !== 'patient') {
      access = await this.access.resolve(auth.accountId);
      // Honors TRUST_PROXY (see configureApp): the client IP, not the proxy's.
      if (
        (auth.kind === 'staff' || holdsInternalRole(access)) &&
        !(await this.access.isInternalPanelIpAllowed(req.ip ?? null))
      ) {
        throw new ForbiddenException({ error: 'network_not_allowed' });
      }
    }

    if (auth.stage === 'mfa_pending' && rule !== 'pending-mfa') {
      throw new ForbiddenException({ error: 'mfa_required' });
    }
    req.auth = auth;
    // Owner, question 3 of task 9-3: until an internal staff member proves a mobile, only the
    // mobile's own endpoints, logging out and `me` (which tells the panel to ask) answer.
    if (
      !this.reflector.getAllAndOverride<boolean | undefined>(MOBILE_EXEMPT_METADATA, [
        context.getHandler(),
        context.getClass(),
      ]) &&
      (await staffMobileRequired(this.config, auth))
    ) {
      throw new ForbiddenException({ error: 'mobile_required' });
    }
    if (rule === 'self-service' || rule === 'pending-mfa') return true;

    if (typeof rule === 'object') {
      const resolved = access ?? (await this.access.resolve(auth.accountId));
      const allowed =
        'anyPermission' in rule
          ? rule.anyPermission.some((code) => resolved.permissions.has(code))
          : resolved.permissions.has(rule.permission);
      if (allowed) {
        req.access = resolved;
        return true;
      }
    }
    throw new ForbiddenException({ error: 'permission_required' });
  }
}

/** Whether any role is held over an internal scope, rather than a center's tree or oneself. */
export function holdsInternalRole(access: EffectiveAccess): boolean {
  return access.scopes.some((s) => s.kind === 'global' || s.kind === 'city' || s.kind === 'queue');
}
