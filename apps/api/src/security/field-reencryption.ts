import { Injectable } from '@nestjs/common';
import { sql, type SQL } from 'drizzle-orm';
import type { Database } from '../db/database.module';
import type { BlindIndex, BlindIndexDomain } from './blind-index';
import type { FieldCrypto } from './field-crypto';

/**
 * Re-encryption of the encrypted fields under the active key (R4, task 9-3). Each module
 * registers the tables it owns (rule: no module reads another's tables); the audit module's
 * runner goes through them in batches. Payout orders and instruments joined them with the
 * owner's approval of the R4 financial plan (ADR-040, migration 0083): their guards let a
 * running run rewrite the encrypted columns only, and every rewrite is checked in its
 * transaction (verifyRewrite).
 */
export interface ReencryptionBatch {
  /** Rows read in this batch; fewer than asked means the table is done. */
  readonly seen: number;
  /** Rows that had a value under an older key, or an index under an older key. */
  readonly rewritten: number;
  readonly lastId: string | null;
}

export interface FieldReencryptor {
  readonly table: string;
  /**
   * The rows after `afterId`, by id. Every value is decrypted (a value that does not is an
   * error, never skipped); those under an older key are written under the active one and
   * their blind index rebuilt. A dry run writes nothing and locks nothing.
   */
  batch(input: ReencryptionBatchInput): Promise<ReencryptionBatch>;
  /** What in the database would stop a run on this table (a guard not ready), if anything. */
  blockers?(): Promise<string[]>;
  /**
   * For each blind-index column, how many live rows hold an index under each key prefix
   * (the launch check, item 4): the owning module reads its own table, so no other one does.
   */
  blindIndexKeys?(): Promise<BlindIndexKeys[]>;
}

export interface BlindIndexKeys {
  /** `table.column`. */
  readonly column: string;
  /** By key prefix (`v1`, `k2`…), in order; never a value. */
  readonly prefixes: readonly { readonly prefix: string; readonly n: number }[];
}

export interface ReencryptionBatchInput {
  readonly afterId: string | null;
  readonly size: number;
  readonly dryRun: boolean;
  /** The run (null in a dry run), named to the database for its guards (SET LOCAL). */
  readonly runId: string | null;
}

/** Names the run to the database for this transaction: the guards let only a running run in. */
export async function enterRun(
  tx: { execute(query: SQL): Promise<unknown> },
  runId: string | null,
): Promise<void> {
  if (runId !== null) {
    await tx.execute(sql`SELECT set_config('sepehr.field_reencryption_run', ${runId}, true)`);
  }
}

@Injectable()
export class FieldReencryptionRegistry {
  private readonly items = new Map<string, FieldReencryptor>();

  register(reencryptor: FieldReencryptor): void {
    if (this.items.has(reencryptor.table)) {
      throw new Error(`a re-encryptor for ${reencryptor.table} is already registered`);
    }
    this.items.set(reencryptor.table, reencryptor);
  }

  all(): FieldReencryptor[] {
    return [...this.items.values()].sort((a, b) => a.table.localeCompare(b.table));
  }
}

type Row = Record<string, unknown>;

export interface EncryptedColumn {
  /** The column of the stored value (a constant of the owning module, never input). */
  readonly column: string;
  readonly context: (row: Row) => string;
  readonly index?: { readonly column: string; readonly domain: (row: Row) => BlindIndexDomain };
}

/**
 * A re-encryptor for plain text columns of one table. `columns`, `table`, `extra` and `join`
 * are constants of the module that owns the table; the table is aliased `t`.
 */
export function columnReencryptor(input: {
  readonly db: Database;
  readonly table: string;
  readonly columns: readonly EncryptedColumn[];
  readonly crypto: FieldCrypto;
  readonly blindIndex?: BlindIndex;
  /** Other columns the contexts need, as `select` items (e.g. `t.node_id`, `c.node_id AS center_node`). */
  readonly extra?: readonly string[];
  readonly join?: string;
  /** After a row is rewritten in a run, in the same transaction (e.g. its audit record). */
  readonly onRewrite?: (
    tx: { execute(query: SQL): Promise<unknown> },
    row: Row,
    runId: string,
  ) => Promise<void>;
}): FieldReencryptor {
  const { db, table, columns, crypto, blindIndex } = input;
  const selected = [
    't.id',
    ...columns.flatMap((c) => [`t.${c.column}`, ...(c.index ? [`t.${c.index.column}`] : [])]),
    ...(input.extra ?? []),
  ].join(', ');
  return {
    table,
    blindIndexKeys: async () => {
      const found: BlindIndexKeys[] = [];
      for (const c of columns) {
        if (!c.index) continue;
        const index = c.index.column;
        // Live rows only: a soft-deleted row (rule 7) never matches a search. A table without
        // `deleted_at` has every row live (the key is then absent from the row's JSON).
        const result = (await db.execute(sql`
          SELECT split_part(t.${sql.raw(index)}, '.', 1) AS prefix, count(*)::int AS n
          FROM ${sql.raw(table)} t
          WHERE t.${sql.raw(index)} IS NOT NULL AND to_jsonb(t) ->> 'deleted_at' IS NULL
          GROUP BY 1 ORDER BY 1`)) as { rows: { prefix: string; n: number }[] };
        found.push({ column: `${table}.${index}`, prefixes: result.rows });
      }
      return found;
    },
    batch: ({ afterId, size, dryRun, runId }) =>
      db.transaction(async (tx) => {
        await enterRun(tx, runId);
        const rows = (
          await tx.execute(sql`
            SELECT ${sql.raw(selected)} FROM ${sql.raw(table)} t ${sql.raw(input.join ?? '')}
            WHERE ${afterId === null ? sql`true` : sql`t.id > ${afterId}`}
            ORDER BY t.id LIMIT ${size} ${dryRun ? sql`` : sql`FOR UPDATE OF t`}`)
        ).rows as Row[];
        let rewritten = 0;
        for (const row of rows) {
          const set: SQL[] = [];
          for (const c of columns) {
            const stored = row[c.column];
            if (typeof stored !== 'string') continue;
            const plain = crypto.decrypt(stored, c.context(row));
            if (!crypto.isCurrent(stored)) {
              set.push(sql`${sql.raw(c.column)} = ${crypto.encrypt(plain, c.context(row))}`);
            }
            if (c.index && blindIndex) {
              // Only an index that exists is rebuilt; one the module left empty stays empty.
              const index = row[c.index.column];
              if (typeof index === 'string' && !blindIndex.isCurrent(index)) {
                set.push(
                  sql`${sql.raw(c.index.column)} = ${blindIndex.of(c.index.domain(row), plain)}`,
                );
              }
            }
          }
          if (set.length === 0) continue;
          rewritten += 1;
          if (!dryRun) {
            const id = row['id'] as string;
            await tx.execute(
              sql`UPDATE ${sql.raw(table)} SET ${sql.join(set, sql`, `)} WHERE id = ${id}`,
            );
            await verifyRewrite(tx, table, columns, crypto, blindIndex, row);
            if (input.onRewrite && runId !== null) await input.onRewrite(tx, row, runId);
          }
        }
        return {
          seen: rows.length,
          rewritten,
          lastId: (rows.at(-1)?.['id'] as string | undefined) ?? null,
        };
      }),
  };
}

/**
 * ADR-040: the row as stored now, read back in the run's transaction, decrypts to the value it
 * held before, under the active key, and its index is the active key's. Anything else throws,
 * so the batch rolls back and every row of it keeps its earlier form. The error names the
 * table only, never a value (rule 30).
 */
async function verifyRewrite(
  tx: { execute(query: SQL): Promise<unknown> },
  table: string,
  columns: readonly EncryptedColumn[],
  crypto: FieldCrypto,
  blindIndex: BlindIndex | undefined,
  before: Row,
): Promise<void> {
  const id = before['id'] as string;
  const selected = columns
    .flatMap((c) => [c.column, ...(c.index ? [c.index.column] : [])])
    .join(', ');
  const result = (await tx.execute(
    sql`SELECT ${sql.raw(selected)} FROM ${sql.raw(table)} WHERE id = ${id}`,
  )) as { rows: Row[] };
  const after = result.rows[0];
  const fail = () => new Error(`re-encryption check failed on ${table}`);
  if (!after) throw fail();
  for (const c of columns) {
    const earlier = before[c.column];
    if (typeof earlier !== 'string') continue;
    const stored = after[c.column];
    if (typeof stored !== 'string' || !crypto.isCurrent(stored)) throw fail();
    const plain = crypto.decrypt(earlier, c.context(before));
    if (crypto.decrypt(stored, c.context(before)) !== plain) throw fail();
    if (c.index && blindIndex && typeof before[c.index.column] === 'string') {
      if (after[c.index.column] !== blindIndex.of(c.index.domain(before), plain)) throw fail();
    }
  }
}
