import { describe, expect, it } from 'vitest';
import { stagingLoginCodeFromEnv } from './staging-code';

describe('the staging fixed login code (task 9-4, owner 1405/07/18)', () => {
  it('is off unless set: the code is random', () => {
    expect(stagingLoginCodeFromEnv({})).toBeNull();
    expect(stagingLoginCodeFromEnv({ DEPLOY_ENV: 'staging' })).toBeNull();
  });

  it('works on staging only, never in production', () => {
    expect(
      stagingLoginCodeFromEnv({ DEPLOY_ENV: 'staging', STAGING_FIXED_LOGIN_CODE: '424242' }),
    ).toBe('424242');
    for (const deployEnv of ['production', 'prod', 'Staging', undefined]) {
      expect(() =>
        stagingLoginCodeFromEnv({
          STAGING_FIXED_LOGIN_CODE: '424242',
          NODE_ENV: 'production',
          ...(deployEnv ? { DEPLOY_ENV: deployEnv } : {}),
        }),
      ).toThrow('only with DEPLOY_ENV=staging');
    }
  });

  it('is six digits', () => {
    for (const bad of ['42424', '4242424', '42a242']) {
      expect(() =>
        stagingLoginCodeFromEnv({ DEPLOY_ENV: 'staging', STAGING_FIXED_LOGIN_CODE: bad }),
      ).toThrow('digits only');
    }
  });
});
