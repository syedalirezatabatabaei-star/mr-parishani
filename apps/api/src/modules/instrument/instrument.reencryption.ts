import { Inject, Injectable, type OnModuleInit } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import { AUDIT_LOG, type AuditLog, type SqlExecutor } from '../../common/audit/audit.port';
import { CLI_ACTOR } from '../../common/auth/actor';
import { DATABASE, type Database } from '../../db/database.module';
import { columnReencryptor, FieldReencryptionRegistry } from '../../security/field-reencryption';
import { keyIdOf } from '../../security/key-ring';
import { INSTRUMENT_CRYPTO, INSTRUMENT_NUMBER, type InstrumentCrypto } from './instrument.crypto';

/**
 * R4 [financial] (owner 1405/07/22, ADR-040): every cheque and note number under the active
 * key, and its blind index rebuilt, deleted ones too. Only `number_enc` and `number_bidx` are
 * rewritten: never an amount, a status or the Sayad confirmation. Each rewrite is checked in
 * its transaction and audited there: the key ids and the run, never a number or a ciphertext.
 */
@Injectable()
export class InstrumentReencryption implements OnModuleInit {
  constructor(
    @Inject(DATABASE) private readonly db: Database,
    @Inject(INSTRUMENT_CRYPTO) private readonly crypto: InstrumentCrypto,
    @Inject(AUDIT_LOG) private readonly audit: AuditLog,
    private readonly registry: FieldReencryptionRegistry,
  ) {}

  onModuleInit(): void {
    const { db } = this;
    const { fieldCrypto: crypto, blindIndex } = this.crypto;
    const numbers = columnReencryptor({
      db,
      table: 'instruments',
      crypto,
      blindIndex,
      columns: [
        {
          column: 'number_enc',
          context: () => INSTRUMENT_NUMBER,
          index: { column: 'number_bidx', domain: () => 'instrument_number' },
        },
      ],
      onRewrite: (tx, row, runId) =>
        this.audit.record(
          {
            actor: CLI_ACTOR,
            action: 'instrument.number_key_rotated',
            entityType: 'instrument',
            entityId: row['id'] as string,
            before: {
              numberKey: keyIdOf(row['number_enc'] as string),
              indexKey: keyIdOf(row['number_bidx'] as string),
            },
            after: { runId, numberKey: crypto.activeKeyId, indexKey: blindIndex.activeKeyId },
          },
          tx as SqlExecutor,
        ),
    });
    this.registry.register({
      ...numbers,
      // The instruments' guard keeps the number: a run waits for its re-encryption clause (0083).
      blockers: async () => {
        const found = await db.execute(sql`
          SELECT 1 FROM pg_proc WHERE proname = 'instruments_guard_change'
            AND prosrc LIKE ${'%sepehr.field_reencryption_run%'}`);
        return found.rows.length > 0 ? [] : ['instruments.instruments_guard_change'];
      },
    });
  }
}
