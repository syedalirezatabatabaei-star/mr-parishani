import { ConflictException, ForbiddenException, Inject, Injectable } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import { AUDIT_LOG, type Actor, type AuditLog } from '../../common/audit/audit.port';
import { CLI_ACTOR } from '../../common/auth/actor';
import { CONFIG, type ConfigPort } from '../../common/config/config.port';
import { DATABASE, type Database } from '../../db/database.module';
import { FieldReencryptionRegistry } from '../../security/field-reencryption';

export const REENCRYPTION_BATCH_SIZE = 500;

/** Takes the backup a run needs before it writes anything; returns where it put it. */
export interface BackupTaker {
  take(): Promise<string>;
}

export interface ReencryptionReport {
  readonly tables: readonly { table: string; seen: number; rewritten: number }[];
  /**
   * What in the database would stop a run halfway: CHECK constraints that accept key 1's `v1.`
   * form only, and guards not ready for a run. A run does not start while there are any (their
   * change waits for the owner, task-9-3-decisions part 5).
   */
  readonly blockedBy: readonly string[];
}

const ENTITY = 'audit.field_reencryption';

/**
 * R4 (task 9-3; owner 1405/07/18): the field re-encryption tool, run by hand only (the CLI).
 * - A dry run reads every registered table, decrypts every value and counts what a run would
 *   rewrite; it writes nothing but its audit record.
 * - A run needs an approval of two people (`audit.field_reencryption`, a sensitive key,
 *   still within its `until`), takes each approval once, and takes a backup before writing.
 * Its start, its counts per table (never a value) and its end or failure are audited.
 */
@Injectable()
export class FieldReencryptionService {
  constructor(
    @Inject(DATABASE) private readonly db: Database,
    @Inject(CONFIG) private readonly config: ConfigPort,
    @Inject(AUDIT_LOG) private readonly audit: AuditLog,
    private readonly registry: FieldReencryptionRegistry,
  ) {}

  async dryRun(actor: Actor = CLI_ACTOR): Promise<ReencryptionReport> {
    const report = await this.walk(true);
    await this.audit.record({
      actor,
      action: 'audit.field_reencryption_dry_run',
      entityType: 'config',
      entityId: ENTITY,
      after: report,
    });
    return report;
  }

  /** The approval a run would use, or why there is none. */
  async authorization(now = new Date()): Promise<string> {
    const { value, versionId } = await this.config.resolve(ENTITY, undefined, now);
    if (value.until === null || new Date(value.until).getTime() <= now.getTime()) {
      throw new ForbiddenException({ error: 'reencryption_not_authorized' });
    }
    const used = await this.db.execute(
      sql`SELECT 1 FROM field_reencryption_runs WHERE authorization_version_id = ${versionId}`,
    );
    if (used.rows.length > 0) throw new ConflictException({ error: 'authorization_used' });
    return versionId;
  }

  /** What in the database stops a run: constraints pinned to key 1's form, guards not ready. */
  async blockers(): Promise<string[]> {
    const guards = await Promise.all(
      this.registry.all().map((r) => (r.blockers ? r.blockers() : Promise.resolve([]))),
    );
    return [...(await this.pinnedConstraints()), ...guards.flat()].sort();
  }

  /** The constraints that still pin the stored forms to key 1, as `table.constraint`. */
  async pinnedConstraints(): Promise<string[]> {
    const tables = this.registry.all().map((r) => r.table);
    if (tables.length === 0) return [];
    const rows = await this.db.execute(sql`
      SELECT c.conrelid::regclass::text AS tbl, c.conname AS name FROM pg_constraint c
      WHERE c.contype = 'c'
        AND c.conrelid::regclass::text IN (${sql.join(
          tables.map((t) => sql`${t}`),
          sql`, `,
        )})
        AND pg_get_constraintdef(c.oid) LIKE ${"%'v1.%"}
      ORDER BY 1, 2`);
    return rows.rows.map((r) => `${r['tbl'] as string}.${r['name'] as string}`);
  }

  async run(
    backup: BackupTaker,
    actor: Actor = CLI_ACTOR,
    now = new Date(),
  ): Promise<ReencryptionReport & { runId: string; backupFile: string }> {
    const versionId = await this.authorization(now);
    // A run that would fail halfway on a constraint does not start (the approval is kept).
    const blockedBy = await this.blockers();
    if (blockedBy.length > 0) {
      throw new ConflictException({ error: 'database_constraints_pin_key_1', blockedBy });
    }
    // Nothing is written before the backup exists.
    const backupFile = await backup.take();
    let runId: string;
    try {
      const made = await this.db.execute(sql`
        INSERT INTO field_reencryption_runs (authorization_version_id, backup_file)
        VALUES (${versionId}, ${backupFile}) RETURNING id`);
      runId = made.rows[0]?.['id'] as string;
    } catch (error) {
      if ((error as { code?: string }).code === '23505') {
        throw new ConflictException({ error: 'authorization_used' });
      }
      throw error;
    }
    const record = (action: string, after: unknown) =>
      this.audit.record({
        actor,
        action: `audit.field_reencryption_${action}`,
        entityType: 'field_reencryption_run',
        entityId: runId,
        after,
      });
    await record('started', { authorizationVersionId: versionId, backupFile });
    try {
      const report = await this.walk(false, runId);
      await this.db.execute(sql`
        UPDATE field_reencryption_runs
        SET outcome = 'completed', counts = ${JSON.stringify(report.tables)}::jsonb,
            finished_at = now()
        WHERE id = ${runId}`);
      await record('completed', report);
      return { ...report, runId, backupFile };
    } catch (error) {
      await this.db.execute(sql`
        UPDATE field_reencryption_runs SET outcome = 'failed', finished_at = now()
        WHERE id = ${runId}`);
      // The kind of error only: a message could hold a value (rule 30).
      await record('failed', { error: error instanceof Error ? error.name : 'unknown' });
      throw error;
    }
  }

  private async walk(dryRun: boolean, runId: string | null = null): Promise<ReencryptionReport> {
    const blockedBy = dryRun ? await this.blockers() : [];
    const tables: { table: string; seen: number; rewritten: number }[] = [];
    for (const reencryptor of this.registry.all()) {
      let afterId: string | null = null;
      let seen = 0;
      let rewritten = 0;
      for (;;) {
        const batch = await reencryptor.batch({
          afterId,
          size: REENCRYPTION_BATCH_SIZE,
          dryRun,
          runId,
        });
        seen += batch.seen;
        rewritten += batch.rewritten;
        afterId = batch.lastId;
        if (batch.seen < REENCRYPTION_BATCH_SIZE) break;
      }
      tables.push({ table: reencryptor.table, seen, rewritten });
    }
    return { tables, blockedBy };
  }
}
