export {
  ApiError,
  createApiClient,
  unwrap,
  type ApiClient,
  type ApiClientOptions,
} from './client.js';
export {
  authApi,
  type Me,
  type MyAccess,
  type OtpRequested,
  type ResolvedScope,
  type SessionStage,
  type TotpEnrollment,
  type WebLogin,
} from './auth.js';
export type { components, operations, paths } from './openapi.js';
