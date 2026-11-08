import type { AuthContext } from '../../common/auth/auth.decorators';
import type { ConfigPort } from '../../common/config/config.port';

/**
 * Owner, question 3 of task 9-3: an internal staff member (account kind `staff`) proves a
 * mobile before anything else, at the next sign-in, through the form the panel then requires.
 * Until then only their own account's endpoints answer; no account is locked or disabled.
 * Center accounts keep task 4-6's rule (a center manager's grant). Off until go-live (م۴).
 */
export async function staffMobileRequired(config: ConfigPort, auth: AuthContext) {
  if (auth.kind !== 'staff' || auth.stage !== 'active' || auth.mobileVerified) return false;
  return (await config.resolve('identity.staff_mobile_required')).value.enabled;
}
