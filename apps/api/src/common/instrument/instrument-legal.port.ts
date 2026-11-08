import type { Actor, SqlExecutor } from '../audit/audit.port';

/**
 * Port to the instrument module's legal action (task 6-8; doc 15 §6): once the collection
 * manager decides a case's legal referral (stage 4, task 6-7), its bounced cheques go to
 * legal action, in that decision's transaction. A promissory note stays held (owner ۵).
 */
export interface InstrumentLegal {
  /** How many instruments moved. */
  referToLegal(actor: Actor, caseId: string, tx: SqlExecutor): Promise<number>;
}

export const INSTRUMENT_LEGAL = Symbol('INSTRUMENT_LEGAL');
