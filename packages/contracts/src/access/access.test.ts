import { describe, expect, it } from 'vitest';
import { isApiModule } from '../modules.js';
import { assignRoleSchema, createRoleSchema, scopeSchema } from './api.js';
import { hiddenFieldsFor, SENSITIVE_FIELD_CLASSES, stripFields } from './fields.js';
import { isPermissionCode, PERMISSION_CODE_FORMAT, PERMISSIONS } from './permissions.js';

describe('PERMISSIONS', () => {
  it('are unique, module.action, and prefixed by a module of the API', () => {
    expect(new Set(PERMISSIONS).size).toBe(PERMISSIONS.length);
    for (const code of PERMISSIONS) {
      expect(code).toMatch(PERMISSION_CODE_FORMAT);
      expect(isApiModule(code.split('.')[0] ?? '')).toBe(true);
    }
  });

  it('recognises codes', () => {
    expect(isPermissionCode('settlement.approve')).toBe(true);
    expect(isPermissionCode('settlement.approve_all')).toBe(false);
  });
});

describe('sensitive fields', () => {
  it('belong to exactly one class, each guarded by a known permission', () => {
    const all = Object.values(SENSITIVE_FIELD_CLASSES).flatMap((c) => c.fields);
    expect(new Set(all).size).toBe(all.length);
    for (const { permission } of Object.values(SENSITIVE_FIELD_CLASSES)) {
      expect(isPermissionCode(permission)).toBe(true);
    }
  });

  it('are hidden unless the class permission is held', () => {
    const hidden = hiddenFieldsFor(new Set(['access.view_credit_score']));
    expect(hidden.has('treatmentDescription')).toBe(true);
    expect(hidden.has('doctorName')).toBe(true);
    expect(hidden.has('creditScore')).toBe(false);
  });

  it('are stripped at any depth, inside arrays too', () => {
    const response = {
      id: 'c1',
      treatmentDescription: 'implant',
      installments: [{ amountRial: '100', doctorName: 'Dr X' }],
      nested: { deeper: { treatmentField: 'dental', dueAt: '2026-10-01' } },
    };
    expect(stripFields(response, hiddenFieldsFor(new Set()))).toEqual({
      id: 'c1',
      installments: [{ amountRial: '100' }],
      nested: { deeper: { dueAt: '2026-10-01' } },
    });
  });

  it('leave the response untouched when nothing is hidden', () => {
    const response = { treatmentDescription: 'x' };
    const everything = new Set(PERMISSIONS as readonly string[]);
    expect(stripFields(response, hiddenFieldsFor(everything))).toBe(response);
  });
});

describe('access request schemas', () => {
  it('accept team queues and reject a person id as a queue', () => {
    expect(scopeSchema.safeParse({ kind: 'queue', code: 'case_completion' }).success).toBe(true);
    expect(
      scopeSchema.safeParse({ kind: 'queue', code: '0199a1b2-0000-7000-8000-000000000000' })
        .success,
    ).toBe(false);
  });

  it('need a node for center and doctor scopes', () => {
    expect(scopeSchema.safeParse({ kind: 'doctor' }).success).toBe(false);
  });

  it('reject unknown permission codes in a role', () => {
    const role = { code: 'night_shift', name: 'شیفت شب', reason: 'نیاز عملیاتی' };
    expect(createRoleSchema.safeParse({ ...role, permissions: ['audit.read'] }).success).toBe(true);
    expect(createRoleSchema.safeParse({ ...role, permissions: ['audit.delete'] }).success).toBe(
      false,
    );
  });

  it('normalize the reason and require one', () => {
    const parsed = assignRoleSchema.parse({
      accountId: '0199a1b2-0000-7000-8000-000000000000',
      roleCode: 'auditor',
      scope: { kind: 'global' },
      reason: 'درخواست مدیر  يك',
    });
    expect(parsed.reason).toBe('درخواست مدیر یک');
    expect(assignRoleSchema.safeParse({ ...parsed, reason: '' }).success).toBe(false);
  });
});
