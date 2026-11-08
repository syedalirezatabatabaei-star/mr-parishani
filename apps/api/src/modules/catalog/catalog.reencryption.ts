import { Inject, Injectable, type OnModuleInit } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import { AUDIT_LOG, type AuditLog, type SqlExecutor } from '../../common/audit/audit.port';
import { CLI_ACTOR } from '../../common/auth/actor';
import { DATABASE, type Database } from '../../db/database.module';
import { keyIdOf } from '../../security/key-ring';
import {
  columnReencryptor,
  enterRun,
  FieldReencryptionRegistry,
} from '../../security/field-reencryption';
import { importContext } from './bulk-import.service';
import {
  CATALOG_CRYPTO,
  type CatalogCrypto,
  centerIdentifierContext,
  centerShebaContext,
  DOCTOR_NATIONAL_ID,
} from './catalog.crypto';

type Row = Record<string, unknown>;
type Secret = { enc?: unknown; last4?: unknown };

/** The encrypted values a valid import row keeps in `data`, by sheet: JSON key and field. */
const IMPORT_SECRETS: Record<string, readonly (readonly [string, string])[]> = {
  centers: [
    ['identifier', 'identifier'],
    ['sheba', 'sheba'],
  ],
  doctors: [['nationalId', 'national_id']],
};

/**
 * The catalog's encrypted fields under the active key (R4, task 9-3): the centers' identifiers
 * and Sheba numbers with their blind indexes, the Sheba of a bank-account change (the center's
 * context), the doctors' national ids, and the values kept in import rows.
 */
@Injectable()
export class CatalogReencryption implements OnModuleInit {
  constructor(
    @Inject(DATABASE) private readonly db: Database,
    @Inject(CATALOG_CRYPTO) private readonly crypto: CatalogCrypto,
    @Inject(AUDIT_LOG) private readonly audit: AuditLog,
    private readonly registry: FieldReencryptionRegistry,
  ) {}

  onModuleInit(): void {
    const { db } = this;
    const { fieldCrypto: crypto, blindIndex } = this.crypto;
    const node = (row: Row, key = 'node_id') => row[key] as string;
    const centers = columnReencryptor({
      db,
      table: 'centers',
      // Owner 1405/07/18: no change of a center's identity or Sheba index goes unaudited; the
      // key ids and the run, never a value.
      onRewrite: (tx, row, runId) =>
        this.audit.record(
          {
            actor: CLI_ACTOR,
            action: 'catalog.center_keys_rotated',
            entityType: 'center',
            entityId: row['id'] as string,
            before: {
              identifierKey: keyIdOf(row['identifier_enc'] as string),
              shebaKey: typeof row['sheba_enc'] === 'string' ? keyIdOf(row['sheba_enc']) : null,
            },
            after: {
              runId,
              identifierKey: crypto.activeKeyId,
              shebaKey: typeof row['sheba_enc'] === 'string' ? crypto.activeKeyId : null,
            },
          },
          tx as SqlExecutor,
        ),
      crypto,
      blindIndex,
      extra: ['t.node_id', 't.person_type'],
      columns: [
        {
          column: 'identifier_enc',
          context: (r) => centerIdentifierContext(node(r)),
          index: {
            column: 'identifier_index',
            domain: (r) => (r['person_type'] === 'natural' ? 'national_id' : 'legal_id'),
          },
        },
        {
          column: 'sheba_enc',
          context: (r) => centerShebaContext(node(r)),
          index: { column: 'sheba_index', domain: () => 'sheba' },
        },
      ],
    });
    this.registry.register({
      ...centers,
      // The centers' guard compares blind indexes: a run waits for its re-encryption clause
      // (proposed migration 0079, the owner's approval; task-9-3-decisions part 5).
      blockers: async () => {
        const found = await db.execute(sql`
          SELECT 1 FROM pg_proc WHERE proname = 'centers_guard_change'
            AND prosrc LIKE ${'%sepehr.field_reencryption_run%'}`);
        return found.rows.length > 0 ? [] : ['centers.centers_guard_change'];
      },
    });
    this.registry.register(
      columnReencryptor({
        db,
        table: 'center_change_requests',
        crypto,
        blindIndex,
        join: 'JOIN centers c ON c.id = t.center_id',
        extra: ['c.node_id AS center_node_id'],
        columns: [
          {
            column: 'sheba_enc',
            context: (r) => centerShebaContext(node(r, 'center_node_id')),
            index: { column: 'sheba_index', domain: () => 'sheba' },
          },
        ],
      }),
    );
    this.registry.register(
      columnReencryptor({
        db,
        table: 'doctors',
        crypto,
        blindIndex,
        columns: [
          {
            column: 'national_id_enc',
            context: () => DOCTOR_NATIONAL_ID,
            index: { column: 'national_id_index', domain: () => 'national_id' },
          },
        ],
      }),
    );
    this.registry.register({
      table: 'catalog_import_rows',
      batch: ({ afterId, size, dryRun, runId }) =>
        db.transaction(async (tx) => {
          await enterRun(tx, runId);
          const rows = (
            await tx.execute(sql`
              SELECT id, batch_id, sheet, row_number, data FROM catalog_import_rows
              WHERE ${afterId === null ? sql`true` : sql`id > ${afterId}`}
              ORDER BY id LIMIT ${size} ${dryRun ? sql`` : sql`FOR UPDATE`}`)
          ).rows as Row[];
          let rewritten = 0;
          for (const row of rows) {
            const data = row['data'] as Record<string, Secret> | null;
            const secrets = IMPORT_SECRETS[row['sheet'] as string] ?? [];
            if (!data) continue;
            let changed = false;
            const next: Record<string, unknown> = { ...data };
            for (const [key, field] of secrets) {
              const secret = data[key];
              if (typeof secret?.enc !== 'string') continue;
              const context = importContext(
                row['batch_id'] as string,
                row['sheet'] as string,
                row['row_number'] as number,
                field,
              );
              const plain = crypto.decrypt(secret.enc, context);
              if (crypto.isCurrent(secret.enc)) continue;
              next[key] = { ...secret, enc: crypto.encrypt(plain, context) };
              changed = true;
            }
            if (!changed) continue;
            rewritten += 1;
            if (!dryRun) {
              await tx.execute(
                sql`UPDATE catalog_import_rows SET data = ${JSON.stringify(next)}::jsonb
                    WHERE id = ${row['id'] as string}`,
              );
            }
          }
          return {
            seen: rows.length,
            rewritten,
            lastId: (rows.at(-1)?.['id'] as string | undefined) ?? null,
          };
        }),
    });
  }
}
