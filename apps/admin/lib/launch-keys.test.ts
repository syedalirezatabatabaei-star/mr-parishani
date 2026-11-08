import { CONFIG_KEYS, isConfigKey } from '@sepehr/contracts';
import { describe, expect, it } from 'vitest';
import {
  LAUNCH_KEYS,
  OTHER_BUSINESS_KEYS,
  shownValue,
  toConfigValue,
  type LaunchKind,
} from './launch-keys';

const kindOf = (key: string): LaunchKind => {
  const k = LAUNCH_KEYS.find((l) => l.key === key);
  if (!k) throw new Error(key);
  return k.kind;
};

/** Every value the page sends is one the key's own schema takes (the server checks it again). */
const valid = (key: string, value: unknown) => {
  if (!isConfigKey(key)) throw new Error(key);
  return CONFIG_KEYS[key].schema.safeParse(value).success;
};

describe('the launch settings keys (plan item الف)', () => {
  it('are known, sensitive (two people), and managed by the permission of their category', () => {
    for (const k of LAUNCH_KEYS) {
      expect(isConfigKey(k.key), k.key).toBe(true);
      if (!isConfigKey(k.key)) continue;
      const def = CONFIG_KEYS[k.key];
      expect(def.sensitive, `${k.key} is sensitive`).toBe(true);
      expect(k.manage, k.key).toBe(
        def.category === 'technical' ? 'config.manage_technical' : 'config.manage_business',
      );
    }
    expect(new Set(LAUNCH_KEYS.map((k) => k.key)).size).toBe(LAUNCH_KEYS.length);
  });

  it('turns the agreed figures, typed in any digits, into values the schemas take', () => {
    const cap = toConfigValue('cap', '۱٬۵۰۰٬۰۰۰٬۰۰۰', {
      capRial: '0',
      basis: 'obligation',
      includeApprovedUnfunded: true,
    });
    expect(cap).toEqual({
      ok: true,
      value: { capRial: '1500000000', basis: 'obligation', includeApprovedUnfunded: true },
    });
    expect(cap.ok && valid('credit.borrower_exposure_cap', cap.value)).toBe(true);

    const deposit = toConfigValue('rial', '990,000', '0');
    expect(deposit).toEqual({ ok: true, value: '990000' });
    expect(deposit.ok && valid('credit.formation_deposit_rial', deposit.value)).toBe(true);

    const count = toConfigValue('count', '١', 0);
    expect(count).toEqual({ ok: true, value: 1 });
    expect(count.ok && valid('instrument.borrower_cheque_min_count', count.value)).toBe(true);

    const bps = toConfigValue('percent', '۱۱۰', 0);
    expect(bps).toEqual({ ok: true, value: 11000 });
    expect(bps.ok && valid('instrument.guarantee_cheque_min_bps', bps.value)).toBe(true);
    expect(toConfigValue('percent', '12.5', 0)).toEqual({ ok: true, value: 1250 });

    for (const key of ['catalog.visit_tariff_internal_only', 'catalog.search_enabled']) {
      const on = toConfigValue(kindOf(key), 'on', false);
      expect(on).toEqual({ ok: true, value: true });
      expect(on.ok && valid(key, on.value)).toBe(true);
      expect(toConfigValue(kindOf(key), 'off', true)).toEqual({ ok: true, value: false });
    }
  });

  it('keeps the cap’s basis and what it counts as they are', () => {
    expect(
      toConfigValue('cap', '2000000000', {
        capRial: '1500000000',
        basis: 'loan',
        includeApprovedUnfunded: false,
      }),
    ).toEqual({
      ok: true,
      value: { capRial: '2000000000', basis: 'loan', includeApprovedUnfunded: false },
    });
  });

  it('refuses a fraction of a rial, tomans written in words, and out-of-range numbers', () => {
    for (const typed of ['990000.5', '۹۹۰ هزار', '', '-5']) {
      expect(toConfigValue('rial', typed, '0').ok, typed).toBe(false);
    }
    for (const typed of ['1.5', '101', 'یک']) {
      expect(toConfigValue('count', typed, 0).ok, typed).toBe(false);
    }
    for (const typed of ['110.555', '1001', 'abc']) {
      expect(toConfigValue('percent', typed, 0).ok, typed).toBe(false);
    }
    expect(toConfigValue('flag', 'maybe', false).ok).toBe(false);
  });

  it('shows the stored values in plain Persian', () => {
    expect(shownValue('rial', '990000')).toBe('۹۹۰٬۰۰۰ ریال (۹۹٬۰۰۰ تومان)');
    expect(shownValue('rial', '0')).toBe('خاموش (۰)');
    expect(shownValue('percent', 11000)).toBe('۱۱۰٪ (۱۱۰۰۰ واحد پایه)');
    expect(shownValue('flag', true)).toBe('روشن');
    expect(
      shownValue('cap', {
        capRial: '1500000000',
        basis: 'obligation',
        includeApprovedUnfunded: true,
      }),
    ).toBe(
      '۱٬۵۰۰٬۰۰۰٬۰۰۰ ریال (۱۵۰٬۰۰۰٬۰۰۰ تومان)، روی آنچه هنوز بدهکار است، با تأییدشده‌های شارژنشده',
    );
  });
});

describe('the other business keys (owner 1405/08/10)', () => {
  const byKey = (key: string) => {
    const k = OTHER_BUSINESS_KEYS.find((o) => o.key === key);
    if (!k) throw new Error(key);
    return k;
  };
  const typed = (key: string, text: string) => {
    const k = byKey(key);
    return toConfigValue(k.kind, text, null, k.bounds);
  };

  it('are the six keys that had no page: known, sensitive, business, none on another page', () => {
    expect(OTHER_BUSINESS_KEYS.map((k) => k.key).sort()).toEqual([
      'instrument.execution_min_days_past_due',
      'instrument.promissory_enabled',
      'repayment.cancellation_penalty_bps',
      'repayment.cancellation_penalty_due_days',
      'repayment.grace_days',
      'settlement.payout_day',
    ]);
    for (const k of OTHER_BUSINESS_KEYS) {
      if (!isConfigKey(k.key)) throw new Error(k.key);
      const def = CONFIG_KEYS[k.key];
      expect(def.sensitive, k.key).toBe(true);
      expect(def.category, k.key).toBe('business');
      expect(k.manage, k.key).toBe('config.manage_business');
      expect(LAUNCH_KEYS.some((l) => l.key === k.key)).toBe(false);
    }
  });

  it('turns typed values in any digits into values the schemas take, at both ends of each range', () => {
    const cases: [string, string, unknown][] = [
      ['repayment.cancellation_penalty_bps', '۱۸', 1800],
      ['repayment.cancellation_penalty_bps', '0', 0],
      ['repayment.cancellation_penalty_bps', '12.5', 1250],
      ['repayment.cancellation_penalty_due_days', '۳۰', 30],
      ['repayment.cancellation_penalty_due_days', '365', 365],
      ['instrument.execution_min_days_past_due', '٠', 0],
      ['instrument.execution_min_days_past_due', '3650', 3650],
      ['instrument.promissory_enabled', 'on', true],
      ['settlement.payout_day', '۱۰', 10],
      ['settlement.payout_day', '29', 29],
      ['repayment.grace_days', '90', 90],
    ];
    for (const [key, text, value] of cases) {
      const parsed = typed(key, text);
      expect(parsed, `${key} ${text}`).toEqual({ ok: true, value });
      expect(parsed.ok && valid(key, parsed.value), key).toBe(true);
    }
  });

  it('refuses what each schema refuses, in Persian, before anything is sent', () => {
    const cases: [string, string][] = [
      ['repayment.cancellation_penalty_bps', '18.01'],
      ['repayment.cancellation_penalty_bps', '19'],
      ['repayment.cancellation_penalty_due_days', '0'],
      ['repayment.cancellation_penalty_due_days', '366'],
      ['instrument.execution_min_days_past_due', '3651'],
      ['settlement.payout_day', '0'],
      ['settlement.payout_day', '30'],
      ['repayment.grace_days', '91'],
      ['repayment.grace_days', '1.5'],
      ['repayment.grace_days', ''],
    ];
    for (const [key, text] of cases) {
      const parsed = typed(key, text);
      expect(parsed.ok, `${key} ${text}`).toBe(false);
      if (!parsed.ok) expect(parsed.error).toMatch(/[؀-ۿ]/);
    }
    expect(typed('settlement.payout_day', '30')).toEqual({
      ok: false,
      error: 'یک عدد صحیح از ۱ تا ۲۹ بنویسید.',
    });
    expect(typed('repayment.cancellation_penalty_bps', '19')).toEqual({
      ok: false,
      error: 'درصد باید از ۰ تا ۱۸ باشد.',
    });
  });

  it('shows days and the day of the month in plain Persian', () => {
    expect(shownValue('days', 30)).toBe('۳۰ روز');
    expect(shownValue('monthday', 10)).toBe('روز ۱۰ هر ماه شمسی');
    expect(shownValue('percent', 1800)).toBe('۱۸٪ (۱۸۰۰ واحد پایه)');
  });
});
