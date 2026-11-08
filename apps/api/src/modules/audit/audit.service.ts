import { Inject, Injectable } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import type { Actor, AuditEventInput, AuditLog, SqlExecutor } from '../../common/audit/audit.port';
import { DATABASE, type Database } from '../../db/database.module';
import { canonicalJson, chainHash, GENESIS_HASH, type ChainedFields } from './hash-chain';

/** Serializes appends so the chain stays linear (pg_advisory_xact_lock key). */
const CHAIN_LOCK = sql`hashtext('audit_events_chain')`;

interface AuditRow extends Record<string, unknown> {
  seq: string;
  id: string;
  /** created_at as the hash saw it: ISO 8601, UTC, milliseconds (see ROW_COLUMNS). */
  created_iso: string;
  actor_account_id: string | null;
  actor_session_id: string | null;
  actor_ip: string | null;
  actor_roles: string[];
  action: string;
  entity_type: string;
  entity_id: string | null;
  before: unknown;
  after: unknown;
  reason: string | null;
  on_behalf_of_doctor_id: string | null;
  prev_hash: string;
  hash: string;
}

export interface AuditEventView {
  readonly seq: string;
  readonly id: string;
  readonly createdAt: string;
  readonly actorAccountId: string | null;
  readonly actorRoles: readonly string[];
  readonly action: string;
  readonly entityType: string;
  readonly entityId: string | null;
  readonly before: unknown;
  readonly after: unknown;
  readonly reason: string | null;
  readonly onBehalfOfDoctorId: string | null;
  readonly ip: string | null;
  readonly sessionId: string | null;
}

export interface ChainVerification {
  readonly ok: boolean;
  readonly checked: number;
  /** seq of the first row whose hash or link does not match. */
  readonly brokenAt: string | null;
}

function fieldsOf(row: AuditRow): ChainedFields {
  return {
    seq: row.seq,
    id: row.id,
    createdAt: row.created_iso,
    actorAccountId: row.actor_account_id,
    actorSessionId: row.actor_session_id,
    actorIp: row.actor_ip,
    actorRoles: row.actor_roles,
    action: row.action,
    entityType: row.entity_type,
    entityId: row.entity_id,
    before: row.before,
    after: row.after,
    reason: row.reason,
    onBehalfOfDoctorId: row.on_behalf_of_doctor_id ?? undefined,
    prevHash: row.prev_hash,
  };
}

/**
 * Every column, and created_at in the exact text the hash covers. Rows are written with
 * a JS Date, so milliseconds are all the precision there is.
 */
const ROW_COLUMNS = sql.raw(
  `*, to_char(created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS created_iso`,
);

/** A JSON value for a jsonb parameter, or SQL NULL. */
const jsonOrNull = (value: unknown) =>
  value === undefined || value === null ? sql`NULL` : sql`${canonicalJson(value)}::jsonb`;

/**
 * The audit trail (doc 04 §7, rule 9): append-only, hash-chained, partitioned by month.
 * Other modules write through the AuditLog port; nothing ever updates or deletes a row
 * (the database refuses both).
 */
@Injectable()
export class AuditService implements AuditLog {
  constructor(@Inject(DATABASE) private readonly db: Database) {}

  async record(event: AuditEventInput, tx?: SqlExecutor): Promise<void> {
    if (tx) {
      await this.append(event, tx);
      return;
    }
    await this.db.transaction((own) => this.append(event, own));
  }

  private async append(event: AuditEventInput, tx: SqlExecutor): Promise<void> {
    // The lock is held to the end of the caller's transaction: appends are serialized,
    // and the row read as "previous" is the one this row really follows.
    await tx.execute(sql`SELECT pg_advisory_xact_lock(${CHAIN_LOCK})`);
    const last = await tx.execute(sql`SELECT hash FROM audit_events ORDER BY seq DESC LIMIT 1`);
    const prevHash = (last.rows[0]?.['hash'] as string | undefined) ?? GENESIS_HASH;
    const next = await tx.execute(
      sql`SELECT nextval('audit_events_seq')::text AS seq, uuidv7() AS id`,
    );
    const seq = next.rows[0]?.['seq'] as string;
    const id = next.rows[0]?.['id'] as string;
    const createdAt = new Date();

    const fields: ChainedFields = {
      seq,
      id,
      createdAt: createdAt.toISOString(),
      actorAccountId: event.actor.accountId,
      actorSessionId: event.actor.sessionId,
      actorIp: event.actor.ip,
      actorRoles: [...event.actor.roles],
      action: event.action,
      entityType: event.entityType,
      entityId: event.entityId,
      // jsonb gives back null for an absent value, so hash null too.
      before: event.before ?? null,
      after: event.after ?? null,
      reason: event.reason ?? null,
      onBehalfOfDoctorId: event.actor.onBehalfOfDoctorId ?? undefined,
      prevHash,
    };
    await tx.execute(sql`
      INSERT INTO audit_events (
        id, seq, created_at, actor_account_id, actor_session_id, actor_ip, actor_roles,
        action, entity_type, entity_id, before, after, reason, on_behalf_of_doctor_id,
        prev_hash, hash
      ) VALUES (
        ${id}, ${seq}, ${createdAt}, ${fields.actorAccountId}, ${fields.actorSessionId},
        ${fields.actorIp}, ${sql.param(fields.actorRoles)}::text[], ${fields.action},
        ${fields.entityType},
        ${fields.entityId}, ${jsonOrNull(fields.before)}, ${jsonOrNull(fields.after)},
        ${fields.reason}, ${fields.onBehalfOfDoctorId ?? null}, ${prevHash}, ${chainHash(fields)}
      )
    `);
  }

  async recordView(actor: Actor, entityType: string, entityId: string): Promise<void> {
    await this.db.execute(sql`
      INSERT INTO access_logs (account_id, session_id, ip, entity_type, entity_id)
      VALUES (${actor.accountId}, ${actor.sessionId}, ${actor.ip}, ${entityType}, ${entityId})
    `);
  }

  /** Events of one entity, newest first. */
  async list(filter: { entityType: string; entityId?: string | undefined; limit: number }) {
    const result = await this.db.execute<AuditRow>(sql`
      SELECT ${ROW_COLUMNS} FROM audit_events
      WHERE entity_type = ${filter.entityType}
        ${filter.entityId === undefined ? sql`` : sql`AND entity_id = ${filter.entityId}`}
      ORDER BY seq DESC
      LIMIT ${filter.limit}
    `);
    return result.rows.map((row): AuditEventView => ({
      seq: row.seq,
      id: row.id,
      createdAt: row.created_iso,
      actorAccountId: row.actor_account_id,
      actorRoles: row.actor_roles,
      action: row.action,
      entityType: row.entity_type,
      entityId: row.entity_id,
      before: row.before,
      after: row.after,
      reason: row.reason,
      onBehalfOfDoctorId: row.on_behalf_of_doctor_id,
      ip: row.actor_ip,
      sessionId: row.actor_session_id,
    }));
  }

  /**
   * Recomputes the chain over every attached row, in batches. The first row's prev_hash
   * is taken as given: older partitions may have been archived (detached).
   */
  async verify(batchSize = 1000): Promise<ChainVerification> {
    let checked = 0;
    let expectedPrev: string | null = null;
    let afterSeq = '-1';
    for (;;) {
      const batch = await this.db.execute<AuditRow>(sql`
        SELECT ${ROW_COLUMNS} FROM audit_events
        WHERE seq > ${afterSeq}::bigint ORDER BY seq LIMIT ${batchSize}
      `);
      for (const row of batch.rows) {
        const linked = expectedPrev === null || row.prev_hash === expectedPrev;
        if (!linked || chainHash(fieldsOf(row)) !== row.hash) {
          return { ok: false, checked, brokenAt: row.seq };
        }
        expectedPrev = row.hash;
        afterSeq = row.seq;
        checked++;
      }
      if (batch.rows.length < batchSize) return { ok: true, checked, brokenAt: null };
    }
  }
}
