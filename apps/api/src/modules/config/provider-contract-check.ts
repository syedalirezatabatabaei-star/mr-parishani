import { Inject, Injectable, Logger } from '@nestjs/common';
import {
  gregorianDayOf,
  providerContractEndsOn,
  providerContractSchema,
  toJalali,
  toPersianDigits,
} from '@sepehr/contracts';
import { sql } from 'drizzle-orm';
import { CONFIG, type ConfigPort } from '../../common/config/config.port';
import { ADMIN_NOTICES, type AdminNotices } from '../../common/config/admin-notices.port';
import { DATABASE, type Database } from '../../db/database.module';

export const PROVIDER_CONTRACT_NOTICE = 'provider_contracts_ending';

export interface ProviderContractResult {
  /** Terms ending within the warning days, not yet ended. */
  readonly ending: number;
  /** Terms already ended: their doctor or center records no new service (ADR-046). */
  readonly ended: number;
  readonly notice: 'raised' | 'resolved';
}

const DAY_MS = 86_400_000;

/**
 * Daily (ADR-046; owner 1405/07/27): the doctors' and centers' contract terms ending within
 * `settlement.provider_contract_warn_days` (30), and those ended. A panel notice for whoever
 * renews them (config.manage_business), with counts only, until every term is renewed. The
 * terms in force are each center's and doctor's latest approved version that has started.
 */
@Injectable()
export class ProviderContractCheck {
  private readonly logger = new Logger(ProviderContractCheck.name);

  constructor(
    @Inject(DATABASE) private readonly db: Database,
    @Inject(CONFIG) private readonly config: ConfigPort,
    @Inject(ADMIN_NOTICES) private readonly notices: AdminNotices,
  ) {}

  async run(now = new Date()): Promise<ProviderContractResult> {
    const { value: warnDays } = await this.config.resolve(
      'settlement.provider_contract_warn_days',
      {},
      now,
    );
    const { rows } = await this.db.execute(sql`
      SELECT DISTINCT ON (scope_level, scope_ref) value
      FROM config_values
      WHERE key = 'settlement.provider_contract' AND scope_level IN ('center', 'doctor')
        AND status = 'approved' AND deleted_at IS NULL
        AND (effective_at IS NULL OR effective_at <= ${now})
      ORDER BY scope_level, scope_ref, effective_at DESC NULLS LAST, created_at DESC
    `);
    const today = gregorianDayOf(toJalali(now));
    const horizon = gregorianDayOf(toJalali(new Date(now.getTime() + warnDays * DAY_MS)));
    let ending = 0;
    let ended = 0;
    for (const row of rows) {
      const term = providerContractSchema.safeParse(row['value']);
      if (!term.success) continue;
      const ends = providerContractEndsOn(term.data);
      if (ends === null) continue;
      if (today >= ends) ended++;
      else if (ends <= horizon) ending++;
    }
    if (ending === 0 && ended === 0) {
      await this.notices.resolve(PROVIDER_CONTRACT_NOTICE, now);
      return { ending, ended, notice: 'resolved' };
    }
    const message =
      `مدت قرارداد ${toPersianDigits(ending)} پزشک یا مرکز تا ${toPersianDigits(warnDays)} روز ` +
      `دیگر پایان می‌یابد و ${toPersianDigits(ended)} پایان یافته است؛ پس از پایان، خدمت تازه ` +
      `ثبت نمی‌شود. تمدید از «نرخ‌های تسویه پزشک».`;
    await this.notices.raise(PROVIDER_CONTRACT_NOTICE, 'config.manage_business', message, now);
    this.logger.warn(`provider contracts: ${String(ending)} ending, ${String(ended)} ended`);
    return { ending, ended, notice: 'raised' };
  }
}
