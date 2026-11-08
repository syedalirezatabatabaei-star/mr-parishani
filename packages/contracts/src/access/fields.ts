import type { PermissionCode } from './permissions.js';

/**
 * Field-level restrictions (doc 04 §4). A response field whose name is listed here reaches
 * only a caller holding the class's permission; the API strips it everywhere else, at any
 * depth of the response, in the output serialization layer. The name is the contract:
 * every module that returns such data uses exactly these property names.
 *
 * - treatment: hidden from the collection unit (description, treatment field, doctor).
 * - creditScore, decisionReasons, patientFinancials: hidden from centers, doctors and
 *   advisors, who see only the service authorization and its limit.
 */
export const SENSITIVE_FIELD_CLASSES = {
  treatment: {
    permission: 'access.view_treatment',
    fields: ['treatmentDescription', 'treatmentField', 'treatmentFieldId', 'doctorName'],
  },
  creditScore: {
    permission: 'access.view_credit_score',
    fields: ['creditScore', 'scoreBreakdown'],
  },
  decisionReasons: {
    permission: 'access.view_decision_reasons',
    fields: ['decisionReasons', 'rejectionReasons'],
  },
  patientFinancials: {
    permission: 'access.view_patient_financials',
    fields: ['patientIncome', 'patientDebts', 'bankStatements'],
  },
} as const satisfies Record<string, { permission: PermissionCode; fields: readonly string[] }>;

export type SensitiveFieldClass = keyof typeof SENSITIVE_FIELD_CLASSES;

/** Field names the holder of `permissions` may not see. */
export function hiddenFieldsFor(permissions: ReadonlySet<string>): Set<string> {
  const hidden = new Set<string>();
  for (const { permission, fields } of Object.values(SENSITIVE_FIELD_CLASSES)) {
    if (!permissions.has(permission)) for (const field of fields) hidden.add(field);
  }
  return hidden;
}

/**
 * A deep copy of `value` without the `hidden` properties, at any depth. Only plain JSON
 * data is walked; anything else (a Date, a stream) is returned as it is.
 */
export function stripFields(value: unknown, hidden: ReadonlySet<string>): unknown {
  if (hidden.size === 0) return value;
  if (Array.isArray(value)) return value.map((item) => stripFields(item, hidden));
  if (value === null || typeof value !== 'object') return value;
  const proto = Object.getPrototypeOf(value) as unknown;
  if (proto !== Object.prototype && proto !== null) return value;
  const out: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value)) {
    if (!hidden.has(key)) out[key] = stripFields(item, hidden);
  }
  return out;
}
