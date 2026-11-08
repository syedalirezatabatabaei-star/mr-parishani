/**
 * Modules of apps/api/src/modules (CLAUDE.md §5). Modules never import each other;
 * the interfaces and injection tokens they share live in this package.
 */
export const API_MODULES = [
  'identity',
  'access',
  'audit',
  'config',
  'catalog',
  'booking',
  'lead',
  'proforma',
  'credit',
  'contract',
  'ledger',
  'wallet',
  'service',
  'settlement',
  'repayment',
  'collection',
  'instrument',
  'ticket',
  'notification',
  'reporting',
] as const;

export type ApiModule = (typeof API_MODULES)[number];

export function isApiModule(value: string): value is ApiModule {
  return (API_MODULES as readonly string[]).includes(value);
}
