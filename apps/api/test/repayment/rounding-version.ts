import { CONFIG, type ConfigPort } from '../../src/common/config/config.port';
import type { Harness } from '../identity/harness';

/**
 * ADR-039: createSchedule needs the rounding version a case locked. A test that funds a
 * purse directly, with no credit application, has none: it passes the version in force
 * now, read through the config port (owner, 1405/07/21: one shared helper).
 */
export async function roundingVersionNow(h: Harness): Promise<string> {
  return (await h.app.get<ConfigPort>(CONFIG).resolve('repayment.rounding_unit_rial')).versionId;
}

/**
 * ADR-041: createSchedule also needs the due-day shift and grace-days versions a case locked.
 * For a purse funded directly, the versions in force now, as roundingVersionNow.
 */
export async function scheduleVersionsNow(h: Harness): Promise<{
  roundingConfigVersionId: string;
  shiftConfigVersionId: string;
  graceConfigVersionId: string;
}> {
  const config = h.app.get<ConfigPort>(CONFIG);
  return {
    roundingConfigVersionId: await roundingVersionNow(h),
    shiftConfigVersionId: (await config.resolve('repayment.shift_due_to_next_working_day'))
      .versionId,
    graceConfigVersionId: (await config.resolve('repayment.grace_days')).versionId,
  };
}
