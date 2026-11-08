import {
  otpRequestSchema,
  otpVerifySchema,
  staffLoginSchema,
  totpCodeSchema,
  type OtpRequest,
  type StaffLogin,
} from '@sepehr/contracts';
import { unwrap, type ApiClient } from './client.js';
import type { paths } from './openapi.js';

/** The JSON body of a route's 200 answer, from the generated types. */
type Ok<P extends keyof paths, M extends 'get' | 'post'> = paths[P][M] extends {
  responses: { 200: { content: { 'application/json': infer T } } };
}
  ? T
  : never;

export type Me = Ok<'/api/v1/auth/me', 'get'>;
export type MyAccess = Ok<'/api/v1/access/me', 'get'>;
export type ResolvedScope = MyAccess['scopes'][number];
export type SessionStage = Me['stage'];
export type OtpRequested = NonNullable<
  paths['/api/v1/auth/otp/request']['post']['responses'][202]['content']
>['application/json'];
export type WebLogin = Ok<'/api/v1/auth/otp/verify', 'post'>;
export type TotpEnrollment = Ok<'/api/v1/auth/totp/enroll', 'post'>;

/**
 * Sign-in and the session (identity module), and what the account may do (access). Inputs
 * are checked and normalized with the shared schemas before they leave (rules 23, 24).
 */
export const authApi = (api: ApiClient) => ({
  me: () => unwrap(api.GET('/api/v1/auth/me')),
  access: () => unwrap(api.GET('/api/v1/access/me')),
  requestOtp: (input: OtpRequest) =>
    unwrap(api.POST('/api/v1/auth/otp/request', { body: otpRequestSchema.parse(input) })),
  verifyOtp: (input: { mobile: string; code: string }) =>
    unwrap(
      api.POST('/api/v1/auth/otp/verify', {
        body: otpVerifySchema.parse({ ...input, client: 'web' }),
      }),
    ),
  staffLogin: (input: Omit<StaffLogin, 'client'>) =>
    unwrap(
      api.POST('/api/v1/auth/staff/login', {
        body: staffLoginSchema.parse({ ...input, client: 'web' }),
      }),
    ),
  enrollTotp: () => unwrap(api.POST('/api/v1/auth/totp/enroll')),
  verifyTotp: (code: string) =>
    unwrap(api.POST('/api/v1/auth/totp/verify', { body: totpCodeSchema.parse({ code }) })),
  sessions: () => unwrap(api.GET('/api/v1/auth/sessions')),
  logout: () => unwrap(api.POST('/api/v1/auth/logout')),
});
