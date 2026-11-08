import {
  bigint,
  integer,
  numeric,
  pgTable,
  real,
  text,
  timestamp,
  uuid,
} from 'drizzle-orm/pg-core';
import { describe, expect, it } from 'vitest';
import { appendOnlyTimestamps, id, rial, timestamps, timestamptz } from '../../src/db/columns';
import { checkSchemaConventions } from '../../src/db/conventions';
import * as schema from '../../src/db/schema';

describe('schema conventions', () => {
  it('hold for every table in the application schema', () => {
    const tables = Object.values(schema) as Parameters<typeof checkSchemaConventions>[0];
    expect(checkSchemaConventions(tables)).toEqual([]);
  });

  it('accept a table built from the column helpers', () => {
    const cases = pgTable('credit_cases', {
      id: id(),
      title: text('title').notNull(),
      approvedAmountRial: rial('approved_amount_rial').notNull(),
      installmentCount: integer('installment_count').notNull(),
      fundedAt: timestamptz('funded_at'),
      ...timestamps(),
    });
    const entries = pgTable('ledger_entries', {
      id: id(),
      amountRial: rial('amount_rial').notNull(),
      ...appendOnlyTimestamps(),
    });
    expect(checkSchemaConventions([cases, entries])).toEqual([]);
  });

  it('reject every broken rule', () => {
    const bad = pgTable('BadTable', {
      id: integer('id').primaryKey(),
      priceToman: real('price_toman'),
      feeRial: numeric('fee_rial'),
      balanceRial: bigint('balance_rial', { mode: 'number' }),
      paidAt: timestamp('paid_at'),
      dueDate: timestamp('due_date', { withTimezone: true }),
      closedAt: text('closed_at'),
      ownerId: uuid('ownerId'),
    });
    expect(checkSchemaConventions([bad])).toEqual([
      'BadTable: table name is not snake_case',
      'BadTable: needs a uuid primary key named id',
      'BadTable: needs created_at',
      'BadTable.price_toman: floating-point or decimal column; money is bigint *_rial',
      'BadTable.fee_rial: floating-point or decimal column; money is bigint *_rial',
      'BadTable.fee_rial: *_rial must be bigint read as a JS bigint',
      'BadTable.balance_rial: *_rial must be bigint read as a JS bigint',
      'BadTable.paid_at: timestamp without time zone',
      'BadTable.due_date: timestamp name must end in _at',
      'BadTable.closed_at: *_at must be timestamptz',
      'BadTable.ownerId: column name is not snake_case',
    ]);
  });

  it('column helpers refuse names without the required suffix', () => {
    expect(() => rial('amount' as `${string}_rial`)).toThrow('_rial');
    expect(() => timestamptz('funded' as `${string}_at`)).toThrow('_at');
  });
});
