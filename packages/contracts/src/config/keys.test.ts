import { describe, expect, it } from 'vitest';
import { isApiModule } from '../modules.js';
import {
  CONFIG_KEY_NAMES,
  CONFIG_KEYS,
  CONFIG_LEVELS,
  configScopeRefSchema,
  isConfigKey,
  proposeConfigSchema,
} from './keys.js';

describe('CONFIG_KEYS', () => {
  it('are module.name, prefixed by a module of the API or ops (the platform itself)', () => {
    for (const key of CONFIG_KEY_NAMES) {
      expect(key).toMatch(/^[a-z]+\.[a-z][a-z_]*$/);
      const prefix = key.split('.')[0] ?? '';
      expect(prefix === 'ops' || prefix === 'calendar' || isApiModule(prefix)).toBe(true);
    }
  });

  it('can each be set globally, so every key always has a value', () => {
    for (const key of CONFIG_KEY_NAMES) {
      expect(CONFIG_KEYS[key].levels).toContain('global');
      for (const level of CONFIG_KEYS[key].levels) expect(CONFIG_LEVELS).toContain(level);
    }
  });

  it('are all sensitive for now (task 0-6 decision)', () => {
    expect(CONFIG_KEY_NAMES.filter((key) => !CONFIG_KEYS[key].sensitive)).toEqual([]);
  });

  it('never take a floating-point number or a JS number of rials', () => {
    const rate = CONFIG_KEYS['repayment.cancellation_penalty_bps'].schema;
    expect(rate.safeParse(1800).success).toBe(true);
    expect(rate.safeParse(18.5).success).toBe(false);
    const unit = CONFIG_KEYS['repayment.rounding_unit_rial'].schema;
    expect(unit.safeParse('10000').success).toBe(true);
    expect(unit.safeParse(10000).success).toBe(false);
    expect(unit.safeParse('10000.5').success).toBe(false);
  });

  it('validate the IP allow-list and the audit retention', () => {
    const allowlist = CONFIG_KEYS['access.internal_panel_ip_allowlist'].schema;
    expect(allowlist.safeParse({ enabled: true, cidrs: ['10.0.0.0/8', 'fd00::/8'] }).success).toBe(
      true,
    );
    expect(allowlist.safeParse({ enabled: true, cidrs: ['10.0.0.1'] }).success).toBe(false);
    const retention = CONFIG_KEYS['audit.retention'].schema;
    expect(retention.safeParse({ months: 24 }).success).toBe(true);
    expect(retention.safeParse({ months: 0 }).success).toBe(false);
  });
});

describe('config request schemas', () => {
  it('know the keys', () => {
    expect(isConfigKey('lead.duplicate_window_days')).toBe(true);
    expect(isConfigKey('toString')).toBe(false);
  });

  it('need the right kind of reference for each level', () => {
    expect(configScopeRefSchema.safeParse({ level: 'city', ref: 'tehran' }).success).toBe(true);
    expect(configScopeRefSchema.safeParse({ level: 'doctor', ref: 'tehran' }).success).toBe(false);
    expect(
      configScopeRefSchema.safeParse({
        level: 'doctor',
        ref: '0199a1b2-0000-7000-8000-000000000000',
      }).success,
    ).toBe(true);
  });

  it('require a reason and a known key', () => {
    const base = { key: 'lead.duplicate_window_days', scope: { level: 'global' }, value: 10 };
    expect(proposeConfigSchema.safeParse({ ...base, reason: 'تغییر سیاست' }).success).toBe(true);
    expect(proposeConfigSchema.safeParse({ ...base, reason: '' }).success).toBe(false);
    expect(
      proposeConfigSchema.safeParse({ ...base, key: 'lead.window', reason: 'تغییر سیاست' }).success,
    ).toBe(false);
  });
});
