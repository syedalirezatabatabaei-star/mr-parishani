import {
  createParamDecorator,
  ForbiddenException,
  SetMetadata,
  UnauthorizedException,
  type ExecutionContext,
} from '@nestjs/common';
import type { AuthClient, PermissionCode } from '@sepehr/contracts';
import type { EffectiveAccess } from './access.port';

/**
 * Access markers for endpoints. Every endpoint carries exactly one; the API refuses to
 * start if any has none (RouteAccessAudit), and the global guard (identity module)
 * denies whatever a marker does not allow.
 */
export const ACCESS_METADATA = 'sepehr:access';

export type AccessRule =
  | 'public'
  | 'self-service'
  | 'pending-mfa'
  | { readonly permission: PermissionCode }
  | { readonly anyPermission: readonly PermissionCode[] };

/** No session needed (login endpoints). */
export const Public = () => SetMetadata(ACCESS_METADATA, 'public' satisfies AccessRule);

/** Any logged-in user, acting only on their own account (sessions, logout). */
export const SelfService = () => SetMetadata(ACCESS_METADATA, 'self-service' satisfies AccessRule);

/** Also reachable by a staff session that has passed the password but not yet TOTP. */
export const AllowPendingMfa = () =>
  SetMetadata(ACCESS_METADATA, 'pending-mfa' satisfies AccessRule);

/**
 * Needs this permission through one of the caller's roles (doc 04 §1). The guard checks
 * it; the service still checks scope and ownership of every record (rules 12 and 13).
 */
export const RequirePermission = (permission: PermissionCode) =>
  SetMetadata(ACCESS_METADATA, { permission } satisfies AccessRule);

/**
 * Needs at least one of these permissions (task 2-5: a calendar is changed as its doctor,
 * as a manager in scope, or as Sepehr's operator; each is its own permission). The service
 * decides which one applies to the record, and refuses the rest (rules 12 and 13).
 */
export const RequireAnyPermission = (...permissions: [PermissionCode, ...PermissionCode[]]) =>
  SetMetadata(ACCESS_METADATA, { anyPermission: permissions } satisfies AccessRule);

/**
 * Task 9-3 (owner, question 3): reachable by an internal staff member who has not yet proved
 * a mobile, while that is required: the mobile's own endpoints, logging out and `me`.
 * Everything else answers 403 `mobile_required` until the mobile is proved.
 */
export const MOBILE_EXEMPT_METADATA = 'sepehr:mobile-exempt';
export const AllowWithoutMobile = () => SetMetadata(MOBILE_EXEMPT_METADATA, true);

/** The authenticated caller, attached to the request by the guard. */
export interface AuthContext {
  readonly accountId: string;
  readonly sessionId: string;
  readonly client: AuthClient;
  readonly kind: 'patient' | 'staff' | 'center';
  readonly stage: 'mfa_pending' | 'active';
  /** When the user last proved who they are (password + TOTP, or OTP). */
  readonly authenticatedAt: Date;
  /** Task 9-3 (R1): when this session last gave a TOTP code again; null if never. */
  readonly reauthenticatedAt: Date | null;
  /** Whether the account has a mobile it proved (task 4-6; owner, question 3 of 9-3). */
  readonly mobileVerified: boolean;
}

export interface AuthenticatedRequest {
  auth?: AuthContext;
  /** Set by the guard on `@RequirePermission` and `@RequireAnyPermission` endpoints. */
  access?: EffectiveAccess;
}

/** Injects the {@link AuthContext} of the current request. */
export const CurrentAuth = createParamDecorator(
  (_data: unknown, ctx: ExecutionContext): AuthContext => {
    const auth = ctx.switchToHttp().getRequest<AuthenticatedRequest>().auth;
    if (!auth) throw new UnauthorizedException();
    return auth;
  },
);

/** Injects the caller's {@link EffectiveAccess}; only on permission endpoints. */
export const CurrentAccess = createParamDecorator(
  (_data: unknown, ctx: ExecutionContext): EffectiveAccess => {
    const access = ctx.switchToHttp().getRequest<AuthenticatedRequest>().access;
    if (!access) throw new ForbiddenException({ error: 'permission_required' });
    return access;
  },
);

/**
 * For sensitive actions (doc 04 §6): the user must have logged in within `maxAgeSeconds`,
 * not merely hold a long-lived session.
 */
export function requireRecentAuth(auth: AuthContext, maxAgeSeconds: number, now = new Date()) {
  if (now.getTime() - auth.authenticatedAt.getTime() > maxAgeSeconds * 1000) {
    throw new UnauthorizedException({ error: 'reauthentication_required' });
  }
}
