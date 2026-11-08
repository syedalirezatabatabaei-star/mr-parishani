import { ConflictException } from '@nestjs/common';

/**
 * The legal entities that may earn income in the ledger (ADR-007; CLAUDE.md §1): in
 * version one only Aramesh Sarvat, the lender; Sepehr Salamati is the intermediary and has
 * no income of its own. A code constant, never configuration: adding an entity needs an ADR.
 *
 * Shared by every module that posts income (fees of task 4-3, the down payment of 4-5,
 * the cancellation of 4-8), and by the contract template's guard, so a configured lender
 * can never route income elsewhere.
 */
export const INCOME_ENTITIES = ['aramesh'] as const;
export type IncomeEntity = (typeof INCOME_ENTITIES)[number];

export const isIncomeEntity = (entityId: string): entityId is IncomeEntity =>
  (INCOME_ENTITIES as readonly string[]).includes(entityId);

/** Refuses (409 `entity_not_allowed`) an income posting for any other entity. */
export function assertIncomeEntity(entityId: string): IncomeEntity {
  if (!isIncomeEntity(entityId)) {
    throw new ConflictException({ error: 'entity_not_allowed', entityId });
  }
  return entityId;
}
