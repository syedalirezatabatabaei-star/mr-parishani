import { CONFIG_KEYS, isConfigKey } from '@sepehr/contracts';
import { describe, expect, it } from 'vitest';
import { SETTING_KEYS } from './settings-keys';

/**
 * The settings page (owner 1405/07/24): every key it changes needs two people. The server
 * holds that for sensitive keys only (config service and database), so each key here must be
 * sensitive, and the page must ask for the permission of the key's own category.
 */
describe('the settings page keys', () => {
  it('are known, sensitive, and managed by the permission of their category', () => {
    for (const s of SETTING_KEYS) {
      expect(isConfigKey(s.key), s.key).toBe(true);
      if (!isConfigKey(s.key)) continue;
      const def = CONFIG_KEYS[s.key];
      expect(def.sensitive, `${s.key} is sensitive`).toBe(true);
      expect(s.manage, s.key).toBe(
        def.category === 'technical' ? 'config.manage_technical' : 'config.manage_business',
      );
    }
  });

  it('flags only where the value is a boolean or { enabled }, offered off first', () => {
    for (const s of SETTING_KEYS.filter((k) => k.flag)) {
      if (!isConfigKey(s.key)) continue;
      const schema = CONFIG_KEYS[s.key].schema;
      if (s.flag === 'boolean') expect(schema.safeParse(false).success, s.key).toBe(true);
      else {
        // An object holding an `enabled` boolean (the page keeps the other fields as they are).
        const shape = (
          schema as unknown as {
            shape?: Record<string, { safeParse: (v: unknown) => { success: boolean } }>;
          }
        ).shape;
        expect(shape?.['enabled']?.safeParse(false).success, s.key).toBe(true);
      }
    }
  });

  it('every label is Persian and every key appears once', () => {
    for (const s of SETTING_KEYS) expect(s.label).toMatch(/[آ-ی]/);
    expect(new Set(SETTING_KEYS.map((s) => s.key)).size).toBe(SETTING_KEYS.length);
  });
});
