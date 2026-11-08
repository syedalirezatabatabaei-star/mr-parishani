import { describe, expect, it } from 'vitest';
import { purseTitleSchema } from './funding.js';

/**
 * Doc 01: a credit purse is «کیف اعتبار», never «کیف» with «پول» (task 4-7). The phrase is
 * built from its words here too: no file of the repository holds it (build plan 1-2's test).
 */
const purse = 'کیف';
const money = 'پول';

describe('purseTitleSchema', () => {
  it('takes a name of two to sixty letters', () => {
    expect(purseTitleSchema.safeParse('کیف اعتبار').success).toBe(true);
    expect(purseTitleSchema.safeParse('اعتبار درمان').success).toBe(true);
    expect(purseTitleSchema.safeParse('ک').success).toBe(false);
    expect(purseTitleSchema.safeParse('ا'.repeat(61)).success).toBe(false);
  });

  it('refuses the money-wallet phrase however it is spaced', () => {
    for (const title of [
      `${purse} ${money}`,
      `${purse}‌${money}`,
      `${purse}  ${money} من`,
      `این ${purse} ${money} است`,
    ]) {
      expect(purseTitleSchema.safeParse(title).success).toBe(false);
    }
  });
});
