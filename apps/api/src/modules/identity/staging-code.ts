import { IDENTITY_CONSTANTS } from './identity.policy';

/**
 * A fixed login code for the patients of the penetration tester's staging (owner
 * 1405/07/18, task 9-4): staging only, never production, and never a real SMS there (the
 * worker refuses Kavenegar on staging). Read once at start; any misuse stops the API.
 *
 *   DEPLOY_ENV=staging STAGING_FIXED_LOGIN_CODE=<6 digits>
 *
 * The code replaces only the random login code; its rate limits, expiry, attempts and
 * lockout stay as they are. Consent and service codes stay random.
 */
export function stagingLoginCodeFromEnv(env: NodeJS.ProcessEnv): string | null {
  const code = (env['STAGING_FIXED_LOGIN_CODE'] ?? '').trim();
  if (code === '') return null;
  if (env['DEPLOY_ENV'] !== 'staging') {
    throw new Error('STAGING_FIXED_LOGIN_CODE is allowed only with DEPLOY_ENV=staging');
  }
  if (!new RegExp(`^\\d{${String(IDENTITY_CONSTANTS.otpLength)}}$`).test(code)) {
    throw new Error('STAGING_FIXED_LOGIN_CODE must be the length of a login code, digits only');
  }
  return code;
}
