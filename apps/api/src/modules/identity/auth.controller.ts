import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Inject,
  Param,
  ParseUUIDPipe,
  Post,
  Req,
  Res,
} from '@nestjs/common';
import {
  changePasswordSchema,
  logoutAllResponseSchema,
  passwordChangedSchema,
  loginResponseSchema,
  meResponseSchema,
  mobileTokensSchema,
  otpRequestedSchema,
  otpRequestSchema,
  otpVerifySchema,
  reauthResponseSchema,
  refreshSchema,
  staffLoginSchema,
  sessionListSchema,
  staffLoginResponseSchema,
  totpCodeSchema,
  totpEnrollmentSchema,
  type MobileTokens,
} from '@sepehr/contracts';
import type { Request, Response } from 'express';
import type { z } from 'zod';
import {
  AllowPendingMfa,
  AllowWithoutMobile,
  CurrentAuth,
  Public,
  SelfService,
  type AuthContext,
} from '../../common/auth/auth.decorators';
import { CurrentActor } from '../../common/auth/actor';
import type { Actor } from '../../common/audit/audit.port';
import { ZodBody } from '../../common/zod-body.pipe';
import { ZodResponse } from '../../common/zod-response';
import { CONFIG, type ConfigPort } from '../../common/config/config.port';
import { OtpLoginService } from './otp-login.service';
import { SessionService, type IssuedSession } from './session.service';
import { StaffAuthService } from './staff-auth.service';
import { staffMobileRequired } from './staff-mobile';
import {
  clearSessionCookie,
  ensureDeviceCookie,
  hasMalformedDeviceHeader,
  requestMeta,
  setSessionCookie,
} from './web';

/** Web gets the cookie and its CSRF token; mobile gets tokens in the body. */
function deliver(session: IssuedSession, res: Response) {
  if (session.client === 'web') {
    setSessionCookie(res, session.token);
    return { stage: session.stage, csrfToken: session.csrfToken };
  }
  const tokens: Partial<MobileTokens> = {
    accessToken: session.token,
    accessTokenExpiresAt: session.tokenExpiresAt.toISOString(),
    ...(session.refreshToken ? { refreshToken: session.refreshToken } : {}),
  };
  return { stage: session.stage, ...tokens };
}

@Controller('auth')
export class AuthController {
  constructor(
    private readonly otp: OtpLoginService,
    private readonly staff: StaffAuthService,
    private readonly sessions: SessionService,
    @Inject(CONFIG) private readonly config: ConfigPort,
  ) {}

  /** Always 202 with the same body, whether or not the mobile has an account. */
  @Public()
  @Post('otp/request')
  @ZodResponse(otpRequestedSchema)
  @HttpCode(HttpStatus.ACCEPTED)
  async requestOtp(
    @Body(new ZodBody(otpRequestSchema)) body: z.output<typeof otpRequestSchema>,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ) {
    // A malformed device id would silently skip the per-device limit: refuse it.
    if (hasMalformedDeviceHeader(req))
      throw new BadRequestException({ error: 'invalid_device_id' });
    return this.otp.request(body.mobile, requestMeta(req, ensureDeviceCookie(req, res)));
  }

  @Public()
  @Post('otp/verify')
  @ZodResponse(loginResponseSchema)
  @HttpCode(HttpStatus.OK)
  async verifyOtp(
    @Body(new ZodBody(otpVerifySchema)) body: z.output<typeof otpVerifySchema>,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ) {
    const session = await this.otp.verify(body.mobile, body.code, body.client, requestMeta(req));
    return deliver(session, res);
  }

  @Public()
  @Post('staff/login')
  @ZodResponse(staffLoginResponseSchema)
  @HttpCode(HttpStatus.OK)
  async staffLogin(
    @Body(new ZodBody(staffLoginSchema)) body: z.output<typeof staffLoginSchema>,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ) {
    const deviceId = body.client === 'web' ? ensureDeviceCookie(req, res) : undefined;
    const { session, next } = await this.staff.login(
      body.username,
      body.password,
      body.client,
      requestMeta(req, deviceId),
    );
    return { ...deliver(session, res), next };
  }

  @AllowPendingMfa()
  @Post('totp/enroll')
  @ZodResponse(totpEnrollmentSchema)
  @HttpCode(HttpStatus.OK)
  enrollTotp(@CurrentAuth() auth: AuthContext) {
    return this.staff.enrollTotp(auth);
  }

  @AllowPendingMfa()
  @Post('totp/verify')
  @ZodResponse(loginResponseSchema)
  @HttpCode(HttpStatus.OK)
  async verifyTotp(
    @CurrentAuth() auth: AuthContext,
    @Body(new ZodBody(totpCodeSchema)) body: z.output<typeof totpCodeSchema>,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ) {
    const session = await this.staff.verifyTotp(auth, body.code, requestMeta(req));
    return deliver(session, res);
  }

  /** Mobile only; the used refresh token is dead from now on. */
  @Public()
  @Post('refresh')
  @ZodResponse(mobileTokensSchema)
  @HttpCode(HttpStatus.OK)
  refresh(@Body(new ZodBody(refreshSchema)) body: z.output<typeof refreshSchema>) {
    return this.sessions.refresh(body.refreshToken);
  }

  /** Who is logged in; on web also the CSRF token, e.g. after a page reload. */
  @AllowPendingMfa()
  @AllowWithoutMobile()
  @Get('me')
  @ZodResponse(meResponseSchema)
  async me(@CurrentAuth() auth: AuthContext) {
    return {
      accountId: auth.accountId,
      stage: auth.stage,
      client: auth.client,
      csrfToken: auth.client === 'web' ? this.sessions.csrfToken(auth.sessionId) : null,
      mobileRequired: await staffMobileRequired(this.config, auth),
    };
  }

  /**
   * Task 9-3 (R1): a TOTP code given again, for the sensitive actions of this session only.
   * Once per code; failures counted, locked and audited like a sign-in.
   */
  @SelfService()
  @Post('totp/reauth')
  @ZodResponse(reauthResponseSchema)
  @HttpCode(HttpStatus.OK)
  reauthenticate(
    @CurrentActor() actor: Actor,
    @CurrentAuth() auth: AuthContext,
    @Body(new ZodBody(totpCodeSchema)) body: z.output<typeof totpCodeSchema>,
    @Req() req: Request,
  ) {
    return this.staff.reauthenticate(actor, auth, body.code, requestMeta(req));
  }

  /** Task 9-3 (R2): a staff member's own password, with the current one; other sessions end. */
  @SelfService()
  @Post('password')
  @HttpCode(HttpStatus.OK)
  @ZodResponse(passwordChangedSchema)
  changePassword(
    @CurrentActor() actor: Actor,
    @CurrentAuth() auth: AuthContext,
    @Body(new ZodBody(changePasswordSchema)) body: z.output<typeof changePasswordSchema>,
    @Req() req: Request,
  ) {
    return this.staff.changePassword(actor, auth, body, requestMeta(req));
  }

  @SelfService()
  @Get('sessions')
  @ZodResponse(sessionListSchema)
  listSessions(@CurrentAuth() auth: AuthContext) {
    return this.sessions.list(auth.accountId, auth.sessionId);
  }

  @SelfService()
  @Delete('sessions/:id')
  @HttpCode(HttpStatus.NO_CONTENT)
  async revokeSession(
    @CurrentAuth() auth: AuthContext,
    @Param('id', new ParseUUIDPipe()) id: string,
  ) {
    await this.sessions.revoke(auth.accountId, id, 'revoked_by_user');
  }

  @AllowPendingMfa()
  @AllowWithoutMobile()
  @Post('logout')
  @HttpCode(HttpStatus.NO_CONTENT)
  async logout(@CurrentAuth() auth: AuthContext, @Res({ passthrough: true }) res: Response) {
    await this.sessions.revoke(auth.accountId, auth.sessionId, 'logout');
    clearSessionCookie(res);
  }

  @SelfService()
  @AllowWithoutMobile()
  @Post('logout-all')
  @ZodResponse(logoutAllResponseSchema)
  @HttpCode(HttpStatus.OK)
  async logoutAll(@CurrentAuth() auth: AuthContext, @Res({ passthrough: true }) res: Response) {
    const revoked = await this.sessions.revokeAll(auth.accountId, 'logout_all');
    clearSessionCookie(res);
    return { revoked };
  }
}
