import { createParamDecorator, UnauthorizedException, type ExecutionContext } from '@nestjs/common';
import { parseStepUpHeader, STEP_UP_HEADER } from '@sepehr/contracts';
import type { Request } from 'express';
import type { Actor } from '../audit/audit.port';
import type { AuthenticatedRequest } from './auth.decorators';

/** The {@link Actor} of an authenticated request, for the audit trail. */
export function actorOf(req: Request & AuthenticatedRequest): Actor {
  if (!req.auth) throw new UnauthorizedException();
  return {
    accountId: req.auth.accountId,
    sessionId: req.auth.sessionId,
    // Honors TRUST_PROXY (see configureApp).
    ip: req.ip ?? null,
    roles: req.access?.roles ?? [],
    reauthenticatedAt: req.auth.reauthenticatedAt,
    stepUp: parseStepUpHeader(req.headers[STEP_UP_HEADER]),
  };
}

/** Injects the {@link Actor} of the current request. */
export const CurrentActor = createParamDecorator((_data: unknown, ctx: ExecutionContext): Actor =>
  actorOf(ctx.switchToHttp().getRequest<Request & AuthenticatedRequest>()),
);

/** The actor of a command-line operation (bootstrap, maintenance). */
export const CLI_ACTOR: Actor = { accountId: null, sessionId: null, ip: null, roles: ['cli'] };
