import { Inject, Injectable, type OnModuleInit } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import { AUDIT_LOG, type AuditLog, type SqlExecutor } from '../../common/audit/audit.port';
import { CLI_ACTOR } from '../../common/auth/actor';
import { DATABASE, type Database } from '../../db/database.module';
import type { FieldCrypto } from '../../security/field-crypto';
import { columnReencryptor, FieldReencryptionRegistry } from '../../security/field-reencryption';
import { keyIdOf } from '../../security/key-ring';
import { ibanContext, SETTLEMENT_CRYPTO } from './payout.service';

/**
 * R4 [financial] (owner 1405/07/22, ADR-040): the Sheba snapshot of every payout order under
 * the active key, confirmed and failed ones too (the Sheba is the same, only its ciphertext
 * changes). Only `iban_enc` is rewritten: never an amount, a status, a statement or a ledger
 * document. Each rewrite is checked in its transaction and audited there: the key ids and the
 * run, never a Sheba or a ciphertext.
 */
@Injectable()
export class SettlementReencryption implements OnModuleInit {
  constructor(
    @Inject(DATABASE) private readonly db: Database,
    @Inject(SETTLEMENT_CRYPTO) private readonly crypto: FieldCrypto,
    @Inject(AUDIT_LOG) private readonly audit: AuditLog,
    private readonly registry: FieldReencryptionRegistry,
  ) {}

  onModuleInit(): void {
    const { db, crypto } = this;
    const payouts = columnReencryptor({
      db,
      table: 'payout_orders',
      crypto,
      columns: [{ column: 'iban_enc', context: (r) => ibanContext(r['id'] as string) }],
      onRewrite: (tx, row, runId) =>
        this.audit.record(
          {
            actor: CLI_ACTOR,
            action: 'settlement.payout_iban_key_rotated',
            entityType: 'payout_order',
            entityId: row['id'] as string,
            before: { ibanKey: keyIdOf(row['iban_enc'] as string) },
            after: { runId, ibanKey: crypto.activeKeyId },
          },
          tx as SqlExecutor,
        ),
    });
    this.registry.register({
      ...payouts,
      // The orders' guard keeps the Sheba: a run waits for its re-encryption clause (0083).
      blockers: async () => {
        const found = await db.execute(sql`
          SELECT 1 FROM pg_proc WHERE proname = 'payout_orders_guard'
            AND prosrc LIKE ${'%sepehr.field_reencryption_run%'}`);
        return found.rows.length > 0 ? [] : ['payout_orders.payout_orders_guard'];
      },
    });
  }
}
