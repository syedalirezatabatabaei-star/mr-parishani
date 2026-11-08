import { describe, expect, it } from 'vitest';
import {
  createServiceSchema,
  createTreatmentFieldSchema,
  rialAmountSchema,
  setTariffSchema,
  tariffListQuerySchema,
} from './tariffs.js';

const owner = { kind: 'workplace', workplaceId: '0199a0c4-7c1e-7a2b-8e44-5a3c1d2e4f60' } as const;
const reason = 'تعرفه جدید';

describe('catalog request schemas', () => {
  it('normalize names and check codes', () => {
    expect(
      createTreatmentFieldSchema.parse({ code: 'dental', name: 'دندانپزشكي', reason }).name,
    ).toBe('دندانپزشکی');
    expect(
      createTreatmentFieldSchema.safeParse({ code: 'Dental', name: 'دندان', reason }).success,
    ).toBe(false);
    expect(
      createServiceSchema.safeParse({ fieldCode: 'dental', code: 'implant', name: 'ا', reason })
        .success,
    ).toBe(false);
  });
});

describe('rial amounts', () => {
  it('are bigints from decimal strings, Persian digits included, never numbers', () => {
    expect(rialAmountSchema.parse('۱۲۰۰۰۰۰۰')).toBe(12_000_000n);
    expect(rialAmountSchema.parse('900000000000000001')).toBe(900_000_000_000_000_001n);
    for (const bad of ['1.5', '-10', '0012', '1e6', '9999999999999999999', '']) {
      expect(rialAmountSchema.safeParse(bad).success).toBe(false);
    }
    expect(rialAmountSchema.safeParse(1000).success).toBe(false);
  });
});

describe('setting a tariff', () => {
  it('takes free or a range with 0 < min <= max', () => {
    const range = (minRial: string, maxRial: string) =>
      setTariffSchema.safeParse({
        owner,
        serviceCode: 'implant',
        pricing: { kind: 'range', minRial, maxRial },
        reason,
      }).success;
    expect(range('10000000', '25000000')).toBe(true);
    expect(range('10000000', '10000000')).toBe(true);
    expect(range('25000000', '10000000')).toBe(false);
    expect(range('0', '10000000')).toBe(false);
    expect(
      setTariffSchema.safeParse({ owner, serviceCode: 'visit', pricing: { kind: 'free' }, reason })
        .success,
    ).toBe(true);
  });

  it('lists by exactly one owner', () => {
    expect(tariffListQuerySchema.safeParse({ workplaceId: owner.workplaceId }).success).toBe(true);
    expect(tariffListQuerySchema.safeParse({}).success).toBe(false);
    expect(
      tariffListQuerySchema.safeParse({
        workplaceId: owner.workplaceId,
        centerId: owner.workplaceId,
      }).success,
    ).toBe(false);
  });
});
