import { describe, expect, it } from 'vitest';
import { createDoctorSchema, updateDoctorSchema } from './doctors.js';

const workplace = { kind: 'branch', branchId: '0199a0c4-7c1e-7a2b-8e44-5a3c1d2e4f60' } as const;

describe('doctor request schemas', () => {
  it('normalize the council number and the name, and check the national ID', () => {
    const parsed = createDoctorSchema.parse({
      name: 'دكتر علي',
      medicalCouncilNumber: '۱۲۳ ۴۵۶',
      workplace,
      reason: 'ثبت پزشک',
    });
    expect(parsed.medicalCouncilNumber).toBe('123456');
    expect(parsed.name).toBe('دکتر علی');
    expect(
      createDoctorSchema.safeParse({
        name: 'دکتر',
        medicalCouncilNumber: '123456',
        nationalId: '1234567890',
        workplace,
        reason: 'ثبت پزشک',
      }).success,
    ).toBe(false);
  });

  it('take a branch or a private practice as the workplace', () => {
    const base = { name: 'دکتر', medicalCouncilNumber: '123456', reason: 'ثبت پزشک' };
    expect(
      createDoctorSchema.safeParse({
        ...base,
        workplace: { kind: 'private_practice', cityCode: 'tehran' },
      }).success,
    ).toBe(true);
    expect(createDoctorSchema.safeParse({ ...base, workplace: { kind: 'branch' } }).success).toBe(
      false,
    );
  });

  it('need a reason for every edit', () => {
    expect(updateDoctorSchema.safeParse({ name: 'دکتر' }).success).toBe(false);
  });
});
