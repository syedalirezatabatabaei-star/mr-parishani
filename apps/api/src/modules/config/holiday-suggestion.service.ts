import { ForbiddenException, Inject, Injectable } from '@nestjs/common';
import {
  gregorianDayOf,
  holidaySuggestions,
  jalaliMonthLength,
  type HolidaySuggestionsView,
  type PermissionCode,
} from '@sepehr/contracts';
import type { EffectiveAccess } from '../../common/auth/access.port';
import { CONFIG, type ConfigPort } from '../../common/config/config.port';
import {
  HOLIDAY_CALENDAR,
  type HolidayCalendarPort,
} from '../../common/config/holiday-calendar.port';
import { CONTRACT_TERMS, type ContractTermsPort } from '../../common/contract/contract-terms.port';
import { WALLET, type WalletPort } from '../../common/wallet/wallet.port';

const MANAGE: PermissionCode = 'config.manage_holidays';

/**
 * The official holidays the panel suggests for a Jalali year (owner 1405/07/23, plan 3, f5;
 * ADR-043). Read only: the rules of `calendar.holiday_rules` laid on the year, each day marked
 * if the calendar has it already, and how many contracts not yet funded print a due day on one
 * of the new days (plan 3 (a)). Saving is one day at a time through the
 * existing `POST /calendar/holidays`; a batch save waits for the owner (1405/07/24).
 */
@Injectable()
export class HolidaySuggestionService {
  constructor(
    @Inject(CONFIG) private readonly config: ConfigPort,
    @Inject(HOLIDAY_CALENDAR) private readonly calendar: HolidayCalendarPort,
    @Inject(CONTRACT_TERMS) private readonly contracts: ContractTermsPort,
    @Inject(WALLET) private readonly wallet: WalletPort,
  ) {}

  async forYear(access: EffectiveAccess, year: number): Promise<HolidaySuggestionsView> {
    // Rule 12: checked here as well as by the guard.
    if (!access.permissions.has(MANAGE)) {
      throw new ForbiddenException({ error: 'permission_required', permission: MANAGE });
    }
    const rules = await this.config.resolve('calendar.holiday_rules');
    const suggested = holidaySuggestions(year, rules.value);
    const national = await this.nationalDaysOf(year);
    const days = suggested.map((d) => ({ ...d, existing: national.has(d.on) }));
    const fresh = days.filter((d) => !d.existing).map((d) => d.on);
    const contractsWithDueOnNewDays = await this.affectedContracts(fresh);
    return { year, rulesVersionId: rules.versionId, days, contractsWithDueOnNewDays };
  }

  /** The Gregorian days of the Jalali year with a national holiday (cityCode null). */
  async nationalDaysOf(year: number): Promise<Set<string>> {
    const entered = await this.calendar.calendarFor({
      from: gregorianDayOf({ year, month: 1, day: 1 }),
      to: gregorianDayOf({ year, month: 12, day: jalaliMonthLength(year, 12) }),
      cityCode: null,
    });
    return new Set(entered.calendar.holidays.filter((h) => h.cityCode === null).map((h) => h.on));
  }

  /**
   * Plan 3 (a): contracts not yet funded with a printed due day among these Gregorian days.
   * A funded one has its schedule built, and it never changes (append-only installments).
   */
  async affectedContracts(days: readonly string[]): Promise<number> {
    let count = 0;
    for (const application of await this.contracts.applicationsWithPrintedDueOn(days)) {
      if ((await this.wallet.purseOfApplication(application)) === null) count += 1;
    }
    return count;
  }
}
