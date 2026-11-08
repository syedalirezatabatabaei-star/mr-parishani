import { createHash } from 'node:crypto';
import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { ModuleRef } from '@nestjs/core';
import {
  FINANCIAL_LINK_TYPES,
  normalizeMobile,
  RESPONDENT_LINK_TYPES,
  TICKET_LIVE_STATUSES,
  TREATMENT_LINK_TYPES,
  type DisputeSubject,
  type TicketKind,
  type PermissionCode,
  type StaffTicketView,
  type TicketChannel,
  type TicketLinkType,
  type TicketQueueRow,
  type TicketStatus,
  type TicketSummary,
  type TicketTopic,
  type TicketAgent,
  type TicketTopicOption,
  type TicketView,
} from '@sepehr/contracts';
import { sql } from 'drizzle-orm';
import { ACCESS_PORT, type AccessPort, type EffectiveAccess } from '../../common/auth/access.port';
import { ACCOUNT_DIRECTORY, type AccountDirectory } from '../../common/auth/account-directory.port';
import {
  AUDIT_LOG,
  type Actor,
  type AuditLog,
  type SqlExecutor,
} from '../../common/audit/audit.port';
import { ADMIN_NOTICES, type AdminNotices } from '../../common/config/admin-notices.port';
import { CONFIG, type ConfigPort } from '../../common/config/config.port';
import { OUTBOX, type OutboxPort } from '../../common/events/outbox.port';
import { ASSIGNMENT_ENGINE, type AssignmentEngine } from '../../common/lead/assignment-engine.port';
import { LEAD_CASES, type LeadCases } from '../../common/lead/lead-cases.port';
import { MALWARE_SCANNER, type MalwareScanner } from '../../common/security/malware-scanner.port';
import {
  SETTLEMENT_DISPUTES,
  type SettlementDisputes,
} from '../../common/settlement/settlement-disputes.port';
import { OBJECT_STORAGE, type ObjectStorage } from '../../common/storage/object-storage.port';
import { scopeCovers, type TicketRequester } from '../../common/ticket/ticket-link-targets.port';
import { DATABASE, type Database } from '../../db/database.module';
import { scannerUnavailable } from '../../infra/clamd';
import { detectDocumentType } from '../../infra/file-type';
import { storageUnavailable } from '../../infra/s3-storage';
import { TicketLinks } from './ticket-links';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const HOUR_MS = 3_600_000;
const DAY_MS = 86_400_000;
const LINK_SECONDS = 60;
const SWEEP_BATCH = 200;
/** A unit's queue in the assignment engine (doc 05 §6; codes take no dot, 0015). */
export const ticketQueue = (unit: string) => `ticket_${unit}`;

const notFound = () => new NotFoundException({ error: 'ticket_not_found' });
const iso = (v: unknown) => new Date(v as string).toISOString();
const isoOrNull = (v: unknown) => (v === null || v === undefined ? null : iso(v));
const isLive = (s: TicketStatus) => TICKET_LIVE_STATUSES.includes(s);

function need(access: EffectiveAccess, permission: PermissionCode) {
  if (!access.permissions.has(permission)) {
    throw new ForbiddenException({ error: 'permission_required', permission });
  }
}

interface TicketRow extends Record<string, unknown> {
  id: string;
  number: string;
  kind: TicketKind;
  topic_code: string;
  unit: string;
  subject: string;
  requester_channel: TicketChannel;
  requester_account_id: string | null;
  requester_person_id: string | null;
  requester_node_id: string | null;
  requester_node_path: string | null;
  status: TicketStatus;
  assignee_account_id: string | null;
  response_hours: number;
  due_at: string | null;
  paused_at: string | null;
  resolved_at: string | null;
  closed_at: string | null;
  reopened_count: number;
  financial_dispute_id: string | null;
  respondent_node_path: string | null;
  created_at: string;
}

const COLUMNS = sql.raw(`id, number::text AS number, kind, topic_code, unit, subject,
  requester_channel, requester_account_id, requester_person_id, requester_node_id,
  requester_node_path::text AS requester_node_path, status, assignee_account_id, response_hours,
  due_at, paused_at, resolved_at, closed_at, reopened_count, financial_dispute_id,
  respondent_node_path::text AS respondent_node_path, created_at`);

const SYSTEM: Actor = { accountId: null, sessionId: null, ip: null, roles: ['system'] };
/** What a decided dispute tells the complaint's requester (task 7-2). */
const DISPUTE_OUTCOME: Record<string, string> = {
  resolved_accepted: 'اختلاف مالی پذیرفته شد.',
  accepted_pending_posting: 'اختلاف مالی پذیرفته شد؛ اصلاح در صورت‌وضعیت بعدی می‌آید.',
  resolved_rejected: 'اختلاف مالی رد شد؛ قلم در صورت‌وضعیت بعدی می‌آید.',
};

/** Who is asking, resolved once per request: their side, and what they may reach. */
export type TicketParty =
  | {
      readonly side: 'patient';
      readonly accountId: string;
      readonly personIds: readonly string[];
    }
  | { readonly side: 'center'; readonly accountId: string; readonly access: EffectiveAccess };

export interface OpenTicketInput {
  readonly topicCode: string;
  readonly subject: string;
  readonly body: string;
  readonly links: readonly { readonly type: TicketLinkType; readonly id: string }[];
  /** The first message tells of the treatment (task 7-2): hidden from collection. */
  readonly containsTreatment?: boolean | undefined;
}

interface UploadedFile {
  readonly buffer: Buffer;
}

/**
 * Tickets (task 7-1; doc 17 §1; docs/decisions/task-7-1-decisions.md). A patient, a center or
 * staff for a caller opens one on a topic of `ticket.topics`, which names the unit and the
 * response deadline (locked on the ticket, rule 16). Links are checked by the module that owns
 * the record (TICKET_LINK_TARGETS), so nobody links what they cannot reach (test 2). The
 * requester never sees an internal note or attachment (test 3). The deadline stops while the
 * ticket waits on the requester and moves by that time when they answer (test 11). Assigned by
 * the lead module's engine to the unit's queue; transferred between units with a reason;
 * every change recorded in ticket_events and audited. Nothing financial is changed from here
 * (doc 04 §3).
 */
@Injectable()
export class TicketService {
  constructor(
    @Inject(DATABASE) private readonly db: Database,
    @Inject(AUDIT_LOG) private readonly audit: AuditLog,
    @Inject(CONFIG) private readonly config: ConfigPort,
    @Inject(OUTBOX) private readonly outbox: OutboxPort,
    @Inject(LEAD_CASES) private readonly leads: LeadCases,
    @Inject(ASSIGNMENT_ENGINE) private readonly engine: AssignmentEngine,
    @Inject(OBJECT_STORAGE) private readonly storage: ObjectStorage,
    @Inject(MALWARE_SCANNER) private readonly scanner: MalwareScanner,
    private readonly links: TicketLinks,
    // Provided by the API and the worker each in its own way; resolved when first used.
    private readonly moduleRef: ModuleRef,
  ) {}

  private get accounts(): AccountDirectory {
    return this.moduleRef.get<AccountDirectory>(ACCOUNT_DIRECTORY, { strict: false });
  }

  private get accessPort(): AccessPort {
    return this.moduleRef.get<AccessPort>(ACCESS_PORT, { strict: false });
  }

  private get notices(): AdminNotices {
    return this.moduleRef.get<AdminNotices>(ADMIN_NOTICES, { strict: false });
  }

  /** The settlement module's disputes (task 7-2); the API only. */
  private get disputes(): SettlementDisputes {
    return this.moduleRef.get<SettlementDisputes>(SETTLEMENT_DISPUTES, { strict: false });
  }

  // --- who is asking ------------------------------------------------------------------------

  /** A patient's account: their merged persons (rule 13). */
  async patient(accountId: string): Promise<TicketParty> {
    const account = await this.accounts.find(accountId);
    if (account?.kind !== 'patient') throw new ForbiddenException({ error: 'patients_only' });
    const personIds = account.personId
      ? await this.leads.samePersonIds(await this.leads.canonicalPersonId(account.personId))
      : [];
    return { side: 'patient', accountId, personIds };
  }

  center(accountId: string, access: EffectiveAccess): TicketParty {
    need(access, 'ticket.open_center');
    return { side: 'center', accountId, access };
  }

  // --- opening ------------------------------------------------------------------------------

  /** A patient's own ticket. */
  async openForPatient(
    actor: Actor,
    party: TicketParty,
    input: OpenTicketInput,
    now = new Date(),
  ): Promise<TicketView> {
    if (party.side !== 'patient') throw new ForbiddenException({ error: 'patients_only' });
    const personId = party.personIds[0];
    if (!personId) throw new ConflictException({ error: 'no_person' });
    const id = await this.open(
      actor,
      {
        channel: 'patient',
        accountId: party.accountId,
        personId,
        nodeId: null,
        nodePath: null,
      },
      { kind: 'person', personIds: party.personIds, accountId: party.accountId },
      input,
      now,
    );
    return this.viewFor(party, id, now);
  }

  /** A center's ticket, from one of the caller's nodes (the first if not named). */
  async openForCenter(
    actor: Actor,
    party: TicketParty,
    input: OpenTicketInput & { readonly nodeId?: string | undefined },
    now = new Date(),
  ): Promise<TicketView> {
    if (party.side !== 'center') throw new ForbiddenException({ error: 'centers_only' });
    const nodes = party.access.scopes.flatMap((s) =>
      s.kind === 'center' || s.kind === 'branch' || s.kind === 'doctor'
        ? [{ id: s.nodeId, path: s.path }]
        : [],
    );
    const node = input.nodeId ? nodes.find((n) => n.id === input.nodeId) : nodes[0];
    if (!node) throw new NotFoundException({ error: 'node_not_found' });
    const id = await this.open(
      actor,
      {
        channel: 'center',
        accountId: party.accountId,
        personId: null,
        nodeId: node.id,
        nodePath: node.path,
      },
      { kind: 'org', access: party.access },
      input,
      now,
    );
    return this.viewFor(party, id, now);
  }

  /** Staff for a caller, by mobile (doc 17 §1): links checked against the caller's person. */
  async openOnBehalf(
    actor: Actor,
    access: EffectiveAccess,
    input: OpenTicketInput & { readonly mobile: string },
    now = new Date(),
  ): Promise<StaffTicketView> {
    need(access, 'ticket.open_on_behalf');
    const mobile = normalizeMobile(input.mobile);
    if (mobile === null) throw new BadRequestException({ error: 'invalid_mobile' });
    const personId = await this.leads.personByMobile(mobile);
    if (personId === null) throw new NotFoundException({ error: 'person_not_found' });
    const personIds = await this.leads.samePersonIds(personId);
    const id = await this.open(
      actor,
      { channel: 'staff', accountId: null, personId, nodeId: null, nodePath: null },
      { kind: 'person', personIds, accountId: null },
      input,
      now,
    );
    return this.staffView(access, id, now, true);
  }

  private async open(
    actor: Actor,
    who: {
      channel: TicketChannel;
      accountId: string | null;
      personId: string | null;
      nodeId: string | null;
      nodePath: string | null;
    },
    requester: TicketRequester,
    input: OpenTicketInput,
    now: Date,
  ): Promise<string> {
    const { topic, versionId } = await this.topic(input.topicCode, now);
    // Each link checked by its module before anything is written; one not reachable is
    // reported as missing, whether or not it exists (test 2).
    const labels: { type: TicketLinkType; id: string; label: string }[] = [];
    for (const link of input.links) {
      if (labels.some((l) => l.type === link.type && l.id === link.id)) continue;
      const label = await this.links.resolve(link.type, link.id, requester);
      if (label === null) {
        throw new NotFoundException({ error: 'link_not_found', type: link.type });
      }
      labels.push({ ...link, label });
    }
    // A financial complaint holds exactly one of the doctor's settlement items (5-2).
    const held = labels.filter((l) => FINANCIAL_LINK_TYPES.includes(l.type));
    if (topic.financial && (held.length !== 1 || requester.kind !== 'org')) {
      throw new BadRequestException({ error: 'financial_link_required' });
    }
    // A complaint about a doctor reaches the panel of the workplace it is about.
    let respondentPath: string | null = null;
    if (topic.kind === 'complaint' && !topic.financial) {
      for (const l of labels.filter((x) => RESPONDENT_LINK_TYPES.includes(x.type))) {
        respondentPath = await this.links.workplaceNodePath(l.type, l.id);
        if (respondentPath) break;
      }
    }
    return this.db.transaction(async (tx) => {
      const dueAt =
        topic.responseHours > 0 ? new Date(now.getTime() + topic.responseHours * HOUR_MS) : null;
      const id = (await tx.execute(sql`SELECT uuidv7() AS id`)).rows[0]?.['id'] as string;
      // The hold first, in this transaction (owner ج۳): refused, nothing is written at all.
      const item = held[0];
      const disputeId =
        topic.financial && item && requester.kind === 'org'
          ? await this.disputes.openForTicket(
              tx,
              actor,
              requester.access,
              {
                subjectType: item.type as DisputeSubject,
                subjectId: item.id,
                reason: (input.body.trim().length >= 3 ? input.body : input.subject).slice(0, 1000),
              },
              id,
            )
          : null;
      await tx.execute(sql`
        INSERT INTO tickets (id, kind, topic_code, unit, subject, requester_channel,
          requester_account_id, requester_person_id, requester_node_id, requester_node_path,
          opened_by, response_hours, config_version_id, due_at, financial_dispute_id,
          respondent_node_path, created_at)
        VALUES (${id}, ${topic.kind}, ${topic.code}, ${topic.unit}, ${input.subject},
          ${who.channel}, ${who.accountId}, ${who.personId}, ${who.nodeId},
          ${who.nodePath}::ltree, ${actor.accountId}, ${topic.responseHours}, ${versionId},
          ${dueAt?.toISOString() ?? null}, ${disputeId}, ${respondentPath}::ltree,
          ${now.toISOString()})
      `);
      await tx.execute(sql`
        INSERT INTO ticket_messages (ticket_id, author_account_id, author_side, visibility, body,
          contains_treatment, created_at)
        VALUES (${id}, ${actor.accountId}, 'requester', 'public', ${input.body},
          ${input.containsTreatment ?? false}, ${now.toISOString()})
      `);
      if (disputeId !== null) {
        await this.outbox.publish(
          {
            type: 'complaint.financial_opened',
            aggregateType: 'ticket',
            aggregateId: id,
            payload: { ticketId: id, unit: topic.unit, status: 'open', disputeId },
          },
          tx,
        );
      }
      for (const link of labels) {
        await tx.execute(sql`
          INSERT INTO ticket_links (ticket_id, entity_type, entity_id, label, created_by)
          VALUES (${id}, ${link.type}, ${link.id}, ${link.label}, ${actor.accountId})
        `);
      }
      await this.opened(tx, actor, id, topic.unit, who.channel, now);
      return id;
    });
  }

  /**
   * Task 3-4's dispute of a proforma, as a ticket (the `proforma.disputed` consumer): once per
   * proforma (`source`), with the patient's note and the link, then assigned. A topic taken
   * out of the configuration still opens it, for support with no deadline.
   */
  async openFromProformaDispute(
    tx: SqlExecutor,
    actor: Actor,
    input: {
      proformaId: string;
      personId: string;
      version: number;
      note: string | null;
      label: string;
    },
    now = new Date(),
  ): Promise<string | null> {
    const resolved = await this.config.resolve('ticket.topics', {}, now);
    const topic = resolved.value.find((t) => t.code === 'proforma_dispute' && t.active) ?? {
      code: 'proforma_dispute',
      unit: 'support',
      responseHours: 0,
    };
    const dueAt =
      topic.responseHours > 0 ? new Date(now.getTime() + topic.responseHours * HOUR_MS) : null;
    const row = (
      await tx.execute(sql`
        INSERT INTO tickets (topic_code, unit, subject, requester_channel, requester_person_id,
          response_hours, config_version_id, due_at, source, source_id, created_at)
        VALUES (${topic.code}, ${topic.unit}, 'اعتراض به پیش‌فاکتور', 'patient', ${input.personId},
          ${topic.responseHours}, ${resolved.versionId}, ${dueAt?.toISOString() ?? null},
          'proforma_dispute', ${input.proformaId}, ${now.toISOString()})
        ON CONFLICT (source, source_id) WHERE source IS NOT NULL DO NOTHING
        RETURNING id
      `)
    ).rows[0];
    if (!row) return null;
    const id = row['id'] as string;
    await tx.execute(sql`
      INSERT INTO ticket_messages (ticket_id, author_side, visibility, body, created_at)
      VALUES (${id}, 'requester', 'public',
        ${input.note && input.note.trim() !== '' ? input.note : 'اعتراض به پیش‌فاکتور'},
        ${now.toISOString()})
    `);
    await tx.execute(sql`
      INSERT INTO ticket_links (ticket_id, entity_type, entity_id, label)
      VALUES (${id}, 'proforma', ${input.proformaId}, ${input.label})
    `);
    await this.opened(tx, actor, id, topic.unit, 'patient', now);
    return id;
  }

  private async opened(
    tx: SqlExecutor,
    actor: Actor,
    id: string,
    unit: string,
    channel: TicketChannel,
    now: Date,
  ) {
    await tx.execute(sql`
      INSERT INTO ticket_events (ticket_id, kind, to_status, to_unit, actor_account_id, created_at)
      VALUES (${id}, 'opened', 'open', ${unit}, ${actor.accountId}, ${now.toISOString()})
    `);
    await this.audit.record(
      {
        actor,
        action: 'ticket.opened',
        entityType: 'ticket',
        entityId: id,
        after: { unit, channel, status: 'open' },
      },
      tx,
    );
    await this.publish(tx, 'ticket.opened', id, unit, 'open');
    await this.assignAuto(tx, actor, id, unit, now);
  }

  private async topic(code: string, now: Date): Promise<{ topic: TicketTopic; versionId: string }> {
    const resolved = await this.config.resolve('ticket.topics', {}, now);
    const topic = resolved.value.find((t) => t.code === code && t.active);
    if (!topic) throw new BadRequestException({ error: 'unknown_topic' });
    return { topic, versionId: resolved.versionId };
  }

  /**
   * The active topics an opener may pick (task 7-7). A financial complaint holds a doctor's
   * own item (7-2), so only a center opens one; a patient's money question is an ordinary
   * accounting ticket (7-2 ج۴).
   */
  async topicsFor(audience: 'patient' | 'center', now = new Date()): Promise<TicketTopicOption[]> {
    const resolved = await this.config.resolve('ticket.topics', {}, now);
    return resolved.value
      .filter((t) => t.active && (audience === 'center' || !t.financial))
      .map((t) => ({ code: t.code, title: t.title, kind: t.kind, financial: t.financial }));
  }

  // --- the requester ------------------------------------------------------------------------

  async listFor(party: TicketParty): Promise<TicketSummary[]> {
    const rows = (
      await this.db.execute(sql`
      SELECT ${COLUMNS} FROM tickets WHERE ${this.requesterFilter(party)}
      ORDER BY created_at DESC, id DESC LIMIT 200
    `)
    ).rows as TicketRow[];
    return rows.map((r) => this.summary(r));
  }

  async viewFor(party: TicketParty, id: string, now = new Date()): Promise<TicketView> {
    const row = await this.requesterRow(party, id);
    return this.requesterView(row, now);
  }

  /** The requester writes: a ticket waiting on them goes back to work, its deadline moved. */
  async replyAsRequester(
    actor: Actor,
    party: TicketParty,
    id: string,
    body: string,
    now = new Date(),
    containsTreatment = false,
  ): Promise<TicketView> {
    await this.requesterRow(party, id);
    await this.db.transaction(async (tx) => {
      const row = await this.lock(tx, id);
      if (!isLive(row.status)) {
        throw new ConflictException({ error: 'ticket_not_open', status: row.status });
      }
      await tx.execute(sql`
        INSERT INTO ticket_messages (ticket_id, author_account_id, author_side, visibility, body,
          contains_treatment, created_at)
        VALUES (${id}, ${actor.accountId}, 'requester', 'public', ${body}, ${containsTreatment},
          ${now.toISOString()})
      `);
      if (row.status === 'waiting_on_requester') {
        await this.move(tx, actor, row, 'in_progress', null, now);
      }
    });
    return this.viewFor(party, id, now);
  }

  /** Within `ticket.reopen_days` of being resolved (doc 17 §1), with a reason. */
  async reopen(
    actor: Actor,
    party: TicketParty,
    id: string,
    reason: string,
    now = new Date(),
  ): Promise<TicketView> {
    await this.requesterRow(party, id);
    const days = (await this.config.resolve('ticket.reopen_days', {}, now)).value;
    await this.db.transaction(async (tx) => {
      const row = await this.lock(tx, id);
      if (row.status !== 'resolved') {
        throw new ConflictException({ error: 'not_resolved', status: row.status });
      }
      // A financial complaint ends with its dispute; a new objection is a new complaint.
      if (row.financial_dispute_id !== null) {
        throw new ConflictException({ error: 'complaint_not_reopenable' });
      }
      if (!this.withinReopen(row, days, now)) {
        throw new ConflictException({ error: 'reopen_window_closed' });
      }
      await tx.execute(sql`
        INSERT INTO ticket_messages (ticket_id, author_account_id, author_side, visibility, body,
          created_at)
        VALUES (${id}, ${actor.accountId}, 'requester', 'public', ${reason}, ${now.toISOString()})
      `);
      await this.move(tx, actor, row, 'reopened', reason, now);
    });
    return this.viewFor(party, id, now);
  }

  /** The requester agrees it is done. */
  async closeAsRequester(
    actor: Actor,
    party: TicketParty,
    id: string,
    now = new Date(),
  ): Promise<TicketView> {
    await this.requesterRow(party, id);
    await this.db.transaction(async (tx) => {
      const row = await this.lock(tx, id);
      if (row.status !== 'resolved') {
        throw new ConflictException({ error: 'not_resolved', status: row.status });
      }
      await this.move(tx, actor, row, 'closed', null, now);
    });
    return this.viewFor(party, id, now);
  }

  private requesterFilter(party: TicketParty) {
    if (party.side === 'patient') {
      const persons =
        party.personIds.length > 0
          ? sql`requester_person_id IN (${sql.join(
              party.personIds.map((p) => sql`${p}::uuid`),
              sql`, `,
            )})`
          : sql`false`;
      return sql`(requester_channel <> 'center' AND (${persons}
        OR requester_account_id = ${party.accountId}))`;
    }
    const paths = party.access.scopes.flatMap((s) =>
      s.kind === 'center' || s.kind === 'branch' || s.kind === 'doctor' ? [s.path] : [],
    );
    if (paths.length === 0) return sql`false`;
    return sql`(requester_channel = 'center' AND (${sql.join(
      paths.map((p) => sql`requester_node_path <@ ${p}::ltree`),
      sql` OR `,
    )}))`;
  }

  /** The ticket if the requester may see it; otherwise it does not exist (rule 13). */
  private async requesterRow(party: TicketParty, id: string): Promise<TicketRow> {
    if (!UUID.test(id)) throw notFound();
    const row = (
      await this.db.execute(sql`
        SELECT ${COLUMNS} FROM tickets WHERE id = ${id} AND ${this.requesterFilter(party)}
      `)
    ).rows[0] as TicketRow | undefined;
    if (!row) throw notFound();
    if (party.side === 'center' && !scopeCovers(party.access, row.requester_node_path ?? '')) {
      throw notFound();
    }
    return row;
  }

  // --- staff --------------------------------------------------------------------------------

  /** Units whose tickets the caller works (their roles), or every unit for managers. */
  private canWork(access: EffectiveAccess, unit: string): boolean {
    return (
      access.permissions.has('ticket.assign') ||
      (access.permissions.has('ticket.work') && access.roles.includes(unit))
    );
  }

  private canRead(access: EffectiveAccess, unit: string): boolean {
    return access.permissions.has('ticket.read_all') || this.canWork(access, unit);
  }

  private async staffRow(access: EffectiveAccess, id: string, work: boolean): Promise<TicketRow> {
    if (!UUID.test(id)) throw notFound();
    const row = await this.row(this.db, id);
    if (!row || !this.canRead(access, row.unit)) throw notFound();
    if (work && !this.canWork(access, row.unit)) {
      throw new ForbiddenException({ error: 'not_your_unit' });
    }
    return row;
  }

  async queue(
    access: EffectiveAccess,
    filter: { unit?: string | undefined; status?: TicketStatus | undefined; mine?: boolean },
    now = new Date(),
  ): Promise<TicketQueueRow[]> {
    const all =
      access.permissions.has('ticket.read_all') || access.permissions.has('ticket.assign');
    if (!all && !access.permissions.has('ticket.work')) {
      throw new ForbiddenException({ error: 'permission_required', permission: 'ticket.work' });
    }
    const units = filter.unit ? [filter.unit] : all ? null : [...access.roles];
    if (units !== null && units.some((u) => !this.canRead(access, u))) {
      throw new ForbiddenException({ error: 'not_your_unit' });
    }
    const rows = (
      await this.db.execute(sql`
      SELECT ${COLUMNS} FROM tickets
      WHERE ${
        units === null
          ? sql`true`
          : units.length === 0
            ? sql`false`
            : sql`unit IN (${sql.join(
                units.map((u) => sql`${u}`),
                sql`, `,
              )})`
      }
        AND ${filter.status ? sql`status = ${filter.status}` : sql`status NOT IN ('resolved', 'closed')`}
        AND ${filter.mine ? sql`assignee_account_id = ${access.accountId}` : sql`true`}
      ORDER BY due_at ASC NULLS LAST, created_at ASC, id ASC
      LIMIT 500
    `)
    ).rows as TicketRow[];
    return rows.map((r) => ({
      ...this.summary(r),
      assigneeAccountId: r.assignee_account_id,
      overdue: this.overdue(r, now),
    }));
  }

  async staffView(
    access: EffectiveAccess,
    id: string,
    now = new Date(),
    justOpened = false,
  ): Promise<StaffTicketView> {
    // The opener (support, an advisor) sees what they opened even outside their unit.
    const row = justOpened ? await this.row(this.db, id) : await this.staffRow(access, id, false);
    if (!row) throw notFound();
    const restricted = this.collectionOnly(access, row);
    const base = await this.requesterView(row, now, restricted ? 'collection' : 'staff');
    const events = await this.db.execute(sql`
      SELECT kind, from_status, to_status, from_unit, to_unit, reason, created_at
      FROM ticket_events WHERE ticket_id = ${id} ORDER BY created_at, id
    `);
    return {
      ...base,
      assigneeAccountId: row.assignee_account_id,
      requesterPersonId: row.requester_person_id,
      requesterAccountId: row.requester_account_id,
      // The collection unit never learns the center (doc 04 §4).
      requesterNodeId: restricted ? null : row.requester_node_id,
      financialDisputeId: row.financial_dispute_id,
      disputeStatus: row.financial_dispute_id
        ? await this.disputes.statusOf(row.financial_dispute_id)
        : null,
      events: events.rows.map((e) => ({
        kind: e['kind'] as StaffTicketView['events'][number]['kind'],
        fromStatus: (e['from_status'] as TicketStatus | null) ?? null,
        toStatus: (e['to_status'] as TicketStatus | null) ?? null,
        fromUnit: (e['from_unit'] as string | null) ?? null,
        toUnit: (e['to_unit'] as string | null) ?? null,
        reason: (e['reason'] as string | null) ?? null,
        createdAt: iso(e['created_at']),
      })),
    };
  }

  /** A reply the requester sees, or an internal note only staff see (test 3). */
  async replyAsStaff(
    actor: Actor,
    access: EffectiveAccess,
    id: string,
    input: { body: string; visibility: 'public' | 'internal'; containsTreatment?: boolean },
    now = new Date(),
  ): Promise<StaffTicketView> {
    await this.staffRow(access, id, true);
    await this.db.transaction(async (tx) => {
      const row = await this.lock(tx, id);
      if (row.status === 'closed') throw new ConflictException({ error: 'ticket_closed' });
      if (row.status === 'resolved' && input.visibility === 'public') {
        throw new ConflictException({ error: 'ticket_not_open', status: row.status });
      }
      await tx.execute(sql`
        INSERT INTO ticket_messages (ticket_id, author_account_id, author_side, visibility, body,
          contains_treatment, created_at)
        VALUES (${id}, ${actor.accountId}, 'staff', ${input.visibility}, ${input.body},
          ${input.containsTreatment ?? false}, ${now.toISOString()})
      `);
    });
    return this.staffView(access, id, now);
  }

  /**
   * Task 7-2: a message marked, after it was written, as telling of the treatment (the message
   * never changes); the collection unit no longer sees it. Once per message.
   */
  async flagMessage(
    actor: Actor,
    access: EffectiveAccess,
    id: string,
    messageId: string,
    reason: string,
    now = new Date(),
  ): Promise<StaffTicketView> {
    await this.staffRow(access, id, true);
    if (!UUID.test(messageId)) throw new NotFoundException({ error: 'message_not_found' });
    const message = (
      await this.db.execute(
        sql`SELECT 1 FROM ticket_messages WHERE id = ${messageId} AND ticket_id = ${id}`,
      )
    ).rows[0];
    if (!message) throw new NotFoundException({ error: 'message_not_found' });
    await this.db.transaction(async (tx) => {
      const made = await tx.execute(sql`
        INSERT INTO ticket_message_flags (ticket_id, message_id, reason, flagged_by, created_at)
        VALUES (${id}, ${messageId}, ${reason}, ${actor.accountId}, ${now.toISOString()})
        ON CONFLICT (message_id) DO NOTHING RETURNING id
      `);
      if (made.rows.length > 0) {
        await this.audit.record(
          {
            actor,
            action: 'ticket.message_flagged',
            entityType: 'ticket',
            entityId: id,
            after: { messageId },
            reason,
          },
          tx,
        );
      }
    });
    return this.staffView(access, id, now);
  }

  /** in_progress, waiting_on_requester or resolved, along the ticket's life. */
  async changeStatus(
    actor: Actor,
    access: EffectiveAccess,
    id: string,
    input: { to: 'in_progress' | 'waiting_on_requester' | 'resolved'; note?: string | undefined },
    now = new Date(),
  ): Promise<StaffTicketView> {
    await this.staffRow(access, id, true);
    await this.db.transaction(async (tx) => {
      const row = await this.lock(tx, id);
      const allowed: Record<typeof input.to, readonly TicketStatus[]> = {
        in_progress: ['assigned', 'waiting_on_requester', 'reopened'],
        waiting_on_requester: ['in_progress'],
        resolved: ['assigned', 'in_progress', 'waiting_on_requester', 'reopened'],
      };
      if (!allowed[input.to].includes(row.status)) {
        throw new ConflictException({ error: 'invalid_transition', status: row.status });
      }
      // A financial complaint is settled only by deciding its dispute (doc 17 §1; 5-2).
      if (input.to === 'resolved' && row.financial_dispute_id !== null) {
        const status = await this.disputes.statusOf(row.financial_dispute_id, tx);
        if (status === null || status === 'open') {
          throw new ConflictException({ error: 'dispute_pending' });
        }
      }
      if (input.note) {
        await tx.execute(sql`
          INSERT INTO ticket_messages (ticket_id, author_account_id, author_side, visibility, body,
            created_at)
          VALUES (${id}, ${actor.accountId}, 'staff', 'public', ${input.note}, ${now.toISOString()})
        `);
      }
      await this.move(tx, actor, row, input.to, input.note ?? null, now);
    });
    return this.staffView(access, id, now);
  }

  /** To another unit, with a reason (doc 17 §1): unassigned there, then the engine's. */
  async transfer(
    actor: Actor,
    access: EffectiveAccess,
    id: string,
    input: { unit: string; reason: string },
    now = new Date(),
  ): Promise<StaffTicketView> {
    await this.staffRow(access, id, true);
    const units = new Set(
      (await this.config.resolve('ticket.topics', {}, now)).value.map((t) => t.unit),
    );
    if (!units.has(input.unit)) throw new BadRequestException({ error: 'unknown_unit' });
    await this.db.transaction(async (tx) => {
      const row = await this.lock(tx, id);
      if (!isLive(row.status)) {
        throw new ConflictException({ error: 'ticket_not_open', status: row.status });
      }
      if (row.unit === input.unit) throw new ConflictException({ error: 'same_unit' });
      const dueAt = this.resumedDue(row, now);
      await tx.execute(sql`
        UPDATE tickets SET status = 'open', assignee_account_id = NULL, unit = ${input.unit},
          due_at = ${dueAt}, paused_at = NULL
        WHERE id = ${id}
      `);
      await tx.execute(sql`
        INSERT INTO ticket_events (ticket_id, kind, from_status, to_status, from_unit, to_unit,
          reason, actor_account_id, created_at)
        VALUES (${id}, 'transferred', ${row.status}, 'open', ${row.unit}, ${input.unit},
          ${input.reason}, ${actor.accountId}, ${now.toISOString()})
      `);
      await this.audit.record(
        {
          actor,
          action: 'ticket.transferred',
          entityType: 'ticket',
          entityId: id,
          before: { unit: row.unit, status: row.status, assignee: row.assignee_account_id },
          after: { unit: input.unit, status: 'open' },
          reason: input.reason,
        },
        tx,
      );
      await this.assignAuto(tx, actor, id, input.unit, now);
    });
    return this.staffView(access, id, now, !this.canRead(access, input.unit));
  }

  /** By hand, with a reason: to someone who works the ticket's unit. */
  /**
   * Task 7-7: who a unit's ticket may be assigned to (ticket.assign): its active staff who work
   * tickets, the same rule `assign` checks. Name and unit only (no mobile, owner's ruling).
   */
  async unitAgents(access: EffectiveAccess, unit: string): Promise<TicketAgent[]> {
    need(access, 'ticket.assign');
    if (!this.canRead(access, unit)) throw new ForbiddenException({ error: 'not_your_unit' });
    const agents: TicketAgent[] = [];
    for (const accountId of await this.accessPort.holdersOf(unit)) {
      const account = await this.accounts.find(accountId);
      if (account?.kind !== 'staff' || account.status !== 'active') continue;
      const theirs = await this.accessPort.resolve(accountId);
      if (!theirs.permissions.has('ticket.work') || !theirs.roles.includes(unit)) continue;
      const name = (await this.accounts.nameOf?.(accountId)) ?? accountId.slice(0, 8);
      agents.push({ accountId, name, unit });
    }
    return agents.sort((a, b) => a.name.localeCompare(b.name, 'fa'));
  }

  async assign(
    actor: Actor,
    access: EffectiveAccess,
    id: string,
    input: { accountId: string; reason: string },
    now = new Date(),
  ): Promise<StaffTicketView> {
    need(access, 'ticket.assign');
    const row0 = await this.staffRow(access, id, true);
    const account = await this.accounts.find(input.accountId);
    const theirs =
      account?.kind === 'staff' && account.status === 'active'
        ? await this.accessPort.resolve(input.accountId)
        : null;
    if (!theirs || !theirs.permissions.has('ticket.work') || !theirs.roles.includes(row0.unit)) {
      throw new ConflictException({ error: 'assignee_not_in_unit' });
    }
    await this.db.transaction(async (tx) => {
      const row = await this.lock(tx, id);
      if (!isLive(row.status)) {
        throw new ConflictException({ error: 'ticket_not_open', status: row.status });
      }
      await this.recordAssignment(tx, actor, row, input.accountId, input.reason, now);
    });
    return this.staffView(access, id, now);
  }

  // --- attachments --------------------------------------------------------------------------

  /** A file of the requester (public) or of staff (public or internal); scanned, real type. */
  async attach(
    actor: Actor,
    by: { party: TicketParty } | { access: EffectiveAccess },
    id: string,
    file: UploadedFile | undefined,
    fields: { containsTreatment: boolean; visibility: 'public' | 'internal' },
    now = new Date(),
  ): Promise<{ id: string }> {
    const staff = 'access' in by;
    if (staff) await this.staffRow(by.access, id, true);
    else await this.requesterRow(by.party, id);
    if (!staff && fields.visibility !== 'public') {
      throw new ForbiddenException({ error: 'staff_only' });
    }
    if (!file || file.buffer.length === 0)
      throw new BadRequestException({ error: 'file_required' });
    if (!this.storage.configured) throw storageUnavailable();
    if (!this.scanner.configured) throw scannerUnavailable();
    const scan = await this.scanner.scan(file.buffer);
    if (!scan.clean) throw new BadRequestException({ error: 'file_infected' });
    const mime = detectDocumentType(file.buffer);
    if (!mime) throw new BadRequestException({ error: 'unsupported_type' });
    const attachmentId = (await this.db.execute(sql`SELECT uuidv7() AS id`)).rows[0]?.[
      'id'
    ] as string;
    const key = `tickets/${id}/${attachmentId}`;
    await this.storage.put('private', key, file.buffer, mime);
    const sha256 = createHash('sha256').update(file.buffer).digest('hex');
    await this.db.transaction(async (tx) => {
      const row = await this.lock(tx, id);
      if (row.status === 'closed') throw new ConflictException({ error: 'ticket_closed' });
      await tx.execute(sql`
        INSERT INTO ticket_attachments (id, ticket_id, visibility, object_key, content_type,
          size_bytes, sha256, contains_treatment, uploaded_by, uploader_side, created_at)
        VALUES (${attachmentId}, ${id}, ${fields.visibility}, ${key}, ${mime},
          ${file.buffer.length}, ${sha256}, ${fields.containsTreatment}, ${actor.accountId},
          ${staff ? 'staff' : 'requester'}, ${now.toISOString()})
      `);
    });
    return { id: attachmentId };
  }

  /** A short-lived link (rule 28); the requester only to public files. */
  async attachmentLink(
    by: { party: TicketParty } | { access: EffectiveAccess },
    id: string,
    attachmentId: string,
  ): Promise<{ url: string; expiresInSeconds: number }> {
    const staff = 'access' in by;
    const ticket = staff
      ? await this.staffRow(by.access, id, false)
      : await this.requesterRow(by.party, id);
    const restricted = staff && this.collectionOnly(by.access, ticket);
    if (!UUID.test(attachmentId)) throw new NotFoundException({ error: 'attachment_not_found' });
    const row = (
      await this.db.execute(sql`
        SELECT object_key FROM ticket_attachments
        WHERE id = ${attachmentId} AND ticket_id = ${id}
          AND ${staff ? sql`true` : sql`visibility = 'public'`}
          AND ${restricted ? sql`NOT contains_treatment` : sql`true`}
      `)
    ).rows[0];
    if (!row) throw new NotFoundException({ error: 'attachment_not_found' });
    return {
      url: await this.storage.signedUrl(row['object_key'] as string, LINK_SECONDS),
      expiresInSeconds: LINK_SECONDS,
    };
  }

  // --- the doctor answering a complaint (task 7-2) -----------------------------------------

  /** Complaints about the workplaces the doctor's scope covers: the public part only. */
  async complaintsFor(access: EffectiveAccess): Promise<TicketSummary[]> {
    need(access, 'ticket.respond');
    const rows = (
      await this.db.execute(sql`
        SELECT ${COLUMNS} FROM tickets WHERE ${this.respondentFilter(access)}
        ORDER BY created_at DESC, id DESC LIMIT 200
      `)
    ).rows as TicketRow[];
    return rows.map((r) => this.summary(r));
  }

  async complaintFor(access: EffectiveAccess, id: string, now = new Date()): Promise<TicketView> {
    return this.requesterView(await this.respondentRow(access, id), now);
  }

  /** The doctor's answer, which the patient sees (doc 17 §1). */
  async respond(
    actor: Actor,
    access: EffectiveAccess,
    id: string,
    body: string,
    now = new Date(),
  ): Promise<TicketView> {
    await this.respondentRow(access, id);
    await this.db.transaction(async (tx) => {
      const row = await this.lock(tx, id);
      if (!isLive(row.status)) {
        throw new ConflictException({ error: 'ticket_not_open', status: row.status });
      }
      await tx.execute(sql`
        INSERT INTO ticket_messages (ticket_id, author_account_id, author_side, visibility, body,
          created_at)
        VALUES (${id}, ${actor.accountId}, 'respondent', 'public', ${body}, ${now.toISOString()})
      `);
    });
    return this.complaintFor(access, id, now);
  }

  private respondentFilter(access: EffectiveAccess) {
    const paths = access.scopes.flatMap((s) =>
      s.kind === 'center' || s.kind === 'branch' || s.kind === 'doctor' ? [s.path] : [],
    );
    if (paths.length === 0) return sql`false`;
    return sql`(kind = 'complaint' AND (${sql.join(
      paths.map((p) => sql`respondent_node_path <@ ${p}::ltree`),
      sql` OR `,
    )}))`;
  }

  private async respondentRow(access: EffectiveAccess, id: string): Promise<TicketRow> {
    need(access, 'ticket.respond');
    if (!UUID.test(id)) throw notFound();
    const row = (
      await this.db.execute(sql`
        SELECT ${COLUMNS} FROM tickets WHERE id = ${id} AND ${this.respondentFilter(access)}
      `)
    ).rows[0] as TicketRow | undefined;
    if (!row) throw notFound();
    return row;
  }

  // --- a financial complaint's dispute decided (task 7-2) ------------------------------------

  /**
   * The `settlement.dispute_resolved` consumer: the complaint holding by this dispute is
   * resolved, its outcome told to the requester in a public message; once.
   */
  async resolveFromDispute(
    tx: SqlExecutor,
    disputeId: string,
    status: string,
    now = new Date(),
  ): Promise<boolean> {
    const found = (
      await tx.execute(sql`SELECT id FROM tickets WHERE financial_dispute_id = ${disputeId}`)
    ).rows[0];
    if (!found) return false;
    const row = await this.lock(tx, found['id'] as string);
    if (!isLive(row.status)) return false;
    const text = DISPUTE_OUTCOME[status] ?? 'اختلاف مالی تعیین تکلیف شد.';
    await tx.execute(sql`
      INSERT INTO ticket_messages (ticket_id, author_side, visibility, body, created_at)
      VALUES (${row.id}, 'staff', 'public', ${text}, ${now.toISOString()})
    `);
    await this.move(tx, SYSTEM, row, 'resolved', `dispute ${status}`, now);
    return true;
  }

  // --- the sweep (worker, every five minutes) -----------------------------------------------

  /**
   * Idempotent: tickets nobody took assigned; each deadline's warning and breach recorded once
   * (never while waiting on the requester); resolved tickets past their reopening closed; the
   * units' managers told the counts (no personal data, rule 30).
   */
  async sweep(
    actor: Actor,
    now = new Date(),
  ): Promise<{ assigned: number; warned: number; breached: number; closed: number }> {
    let assigned = 0;
    const waiting = (
      await this.db.execute(sql`
      SELECT id, unit FROM tickets WHERE status = 'open' ORDER BY created_at, id
      LIMIT ${SWEEP_BATCH}
    `)
    ).rows as { id: string; unit: string }[];
    for (const t of waiting) {
      if (await this.db.transaction((tx) => this.assignAuto(tx, actor, t.id, t.unit, now))) {
        assigned += 1;
      }
    }
    const warnMinutes = (await this.config.resolve('ticket.sla_warning_minutes', {}, now)).value;
    const breached = await this.alert('sla_breached', sql`due_at <= ${now.toISOString()}`, now);
    const warned =
      warnMinutes > 0
        ? await this.alert(
            'sla_warning',
            sql`due_at > ${now.toISOString()}
              AND due_at <= ${new Date(now.getTime() + warnMinutes * 60_000).toISOString()}`,
            now,
          )
        : 0;
    const days = (await this.config.resolve('ticket.reopen_days', {}, now)).value;
    const done = (
      await this.db.execute(sql`
      SELECT ${COLUMNS} FROM tickets
      WHERE status = 'resolved'
        AND resolved_at <= ${new Date(now.getTime() - days * DAY_MS).toISOString()}
      ORDER BY resolved_at, id LIMIT ${SWEEP_BATCH}
    `)
    ).rows as TicketRow[];
    let closed = 0;
    for (const t of done) {
      const moved = await this.db.transaction(async (tx) => {
        const row = await this.lock(tx, t.id);
        if (row.status !== 'resolved') return false;
        await this.move(tx, actor, row, 'closed', null, now);
        return true;
      });
      if (moved) closed += 1;
    }
    await this.tellManagers(now);
    return { assigned, warned, breached, closed };
  }

  private async alert(
    kind: 'sla_warning' | 'sla_breached',
    when: ReturnType<typeof sql>,
    now: Date,
  ) {
    const due = (
      await this.db.execute(sql`
      SELECT id, unit, status, due_at FROM tickets
      WHERE status NOT IN ('resolved', 'closed') AND paused_at IS NULL AND due_at IS NOT NULL
        AND ${when}
      ORDER BY due_at, id LIMIT ${SWEEP_BATCH}
    `)
    ).rows;
    let count = 0;
    for (const t of due) {
      const dueAt = iso(t['due_at']);
      const made = await this.db.transaction(async (tx) => {
        const row = (
          await tx.execute(sql`
            INSERT INTO ticket_events (ticket_id, kind, due_at, created_at)
            VALUES (${t['id'] as string}, ${kind}, ${dueAt}, ${now.toISOString()})
            ON CONFLICT (ticket_id, kind, due_at)
              WHERE kind IN ('sla_warning', 'sla_breached') DO NOTHING
            RETURNING id
          `)
        ).rows[0];
        if (!row) return false;
        await this.outbox.publish(
          {
            type: `ticket.${kind}`,
            aggregateType: 'ticket',
            aggregateId: t['id'] as string,
            payload: {
              ticketId: t['id'],
              unit: t['unit'],
              status: t['status'],
              dueAt,
            },
          },
          tx,
        );
        return true;
      });
      if (made) count += 1;
    }
    return count;
  }

  private async tellManagers(now: Date) {
    const counts = (
      await this.db.execute(sql`
        SELECT
          count(*) FILTER (WHERE status = 'open')::int AS unassigned,
          count(*) FILTER (WHERE paused_at IS NULL AND due_at <= ${now.toISOString()})::int AS late
        FROM tickets WHERE status NOT IN ('resolved', 'closed')
      `)
    ).rows[0];
    const unassigned = Number(counts?.['unassigned'] ?? 0);
    const late = Number(counts?.['late'] ?? 0);
    if (unassigned > 0) {
      await this.notices.raise(
        'ticket_unassigned',
        'ticket.assign',
        `${String(unassigned)} تیکت بی کارشناس مانده است.`,
        now,
      );
    } else {
      await this.notices.resolve('ticket_unassigned', now);
    }
    if (late > 0) {
      await this.notices.raise(
        'ticket_sla_breached',
        'ticket.assign',
        `${String(late)} تیکت از مهلت پاسخ گذشته است.`,
        now,
      );
    } else {
      await this.notices.resolve('ticket_sla_breached', now);
    }
  }

  // --- helpers ------------------------------------------------------------------------------

  /**
   * Task 7-2 (doc 17 §1, test 4): a viewer who reaches a collection ticket only as the
   * collection unit sees no treatment record, nor anything marked as telling of it.
   */
  private collectionOnly(access: EffectiveAccess, row: TicketRow): boolean {
    return (
      row.unit === 'collection' &&
      !access.permissions.has('ticket.read_all') &&
      !access.permissions.has('ticket.assign')
    );
  }

  private async row(ex: SqlExecutor, id: string): Promise<TicketRow | null> {
    return ((await ex.execute(sql`SELECT ${COLUMNS} FROM tickets WHERE id = ${id}`)).rows[0] ??
      null) as TicketRow | null;
  }

  private async lock(tx: SqlExecutor, id: string): Promise<TicketRow> {
    const row = (await tx.execute(sql`SELECT ${COLUMNS} FROM tickets WHERE id = ${id} FOR UPDATE`))
      .rows[0] as TicketRow | undefined;
    if (!row) throw notFound();
    return row;
  }

  /** The deadline after a pause: moved by how long the ticket waited on the requester. */
  private resumedDue(row: TicketRow, now: Date): string | null {
    if (row.due_at === null) return null;
    if (row.paused_at === null) return iso(row.due_at);
    const waited = Math.max(0, now.getTime() - new Date(row.paused_at).getTime());
    return new Date(new Date(row.due_at).getTime() + waited).toISOString();
  }

  /** One step of the ticket's life, with its pause, history, audit and event. */
  private async move(
    tx: SqlExecutor,
    actor: Actor,
    row: TicketRow,
    to: TicketStatus,
    reason: string | null,
    now: Date,
  ) {
    const at = now.toISOString();
    let dueAt = this.resumedDue(row, now);
    if (to === 'reopened' && row.response_hours > 0) {
      dueAt = new Date(now.getTime() + row.response_hours * HOUR_MS).toISOString();
    }
    const pausedAt = to === 'waiting_on_requester' && dueAt !== null ? at : null;
    const resolvedAt = to === 'resolved' ? at : to === 'closed' ? isoOrNull(row.resolved_at) : null;
    await tx.execute(sql`
      UPDATE tickets SET status = ${to}, due_at = ${dueAt}, paused_at = ${pausedAt},
        resolved_at = ${resolvedAt}, closed_at = ${to === 'closed' ? at : null},
        reopened_count = reopened_count + ${to === 'reopened' ? 1 : 0}
      WHERE id = ${row.id}
    `);
    await tx.execute(sql`
      INSERT INTO ticket_events (ticket_id, kind, from_status, to_status, reason, actor_account_id,
        created_at)
      VALUES (${row.id}, 'status', ${row.status}, ${to}, ${reason}, ${actor.accountId}, ${at})
    `);
    await this.audit.record(
      {
        actor,
        action: `ticket.${to}`,
        entityType: 'ticket',
        entityId: row.id,
        before: { status: row.status, dueAt: isoOrNull(row.due_at) },
        after: { status: to, dueAt },
        reason,
      },
      tx,
    );
    if (to === 'resolved' || to === 'reopened') {
      await this.publish(tx, `ticket.${to}`, row.id, row.unit, to);
    }
  }

  /** By the engine (3-5) to the unit's queue; false when nobody can take it now. */
  private async assignAuto(
    tx: SqlExecutor,
    actor: Actor,
    id: string,
    unit: string,
    now: Date,
  ): Promise<boolean> {
    const pick = await this.engine.pick(
      tx,
      { queueCode: ticketQueue(unit), cityCode: null, treatmentFieldCode: null },
      (ids) => this.openCounts(tx, unit, ids),
      now,
    );
    if (!pick) return false;
    const row = await this.lock(tx, id);
    if (row.status !== 'open' || row.unit !== unit) return false;
    await this.recordAssignment(tx, actor, row, pick.accountId, null, now);
    return true;
  }

  private async recordAssignment(
    tx: SqlExecutor,
    actor: Actor,
    row: TicketRow,
    accountId: string,
    reason: string | null,
    now: Date,
  ) {
    const status: TicketStatus = row.status === 'open' ? 'assigned' : row.status;
    await tx.execute(sql`
      UPDATE tickets SET status = ${status}, assignee_account_id = ${accountId} WHERE id = ${row.id}
    `);
    await tx.execute(sql`
      INSERT INTO ticket_events (ticket_id, kind, from_status, to_status, assignee_account_id,
        reason, actor_account_id, created_at)
      VALUES (${row.id}, 'assigned', ${row.status}, ${status}, ${accountId}, ${reason},
        ${actor.accountId}, ${now.toISOString()})
    `);
    await this.audit.record(
      {
        actor,
        action: 'ticket.assigned',
        entityType: 'ticket',
        entityId: row.id,
        before: { assignee: row.assignee_account_id, status: row.status },
        after: { assignee: accountId, status },
        reason,
      },
      tx,
    );
    await this.outbox.publish(
      {
        type: 'ticket.assigned',
        aggregateType: 'ticket',
        aggregateId: row.id,
        payload: { ticketId: row.id, unit: row.unit, status, assigneeAccountId: accountId },
      },
      tx,
    );
  }

  /** Each agent's live tickets of the unit: what their cap counts (agent_caps). */
  private async openCounts(
    tx: SqlExecutor,
    unit: string,
    ids: readonly string[],
  ): Promise<ReadonlyMap<string, number>> {
    if (ids.length === 0) return new Map();
    const rows = await tx.execute(sql`
      SELECT assignee_account_id AS id, count(*)::int AS n FROM tickets
      WHERE unit = ${unit} AND status NOT IN ('open', 'resolved', 'closed')
        AND assignee_account_id IN (${sql.join(
          ids.map((i) => sql`${i}::uuid`),
          sql`, `,
        )})
      GROUP BY assignee_account_id
    `);
    return new Map(rows.rows.map((r) => [r['id'] as string, Number(r['n'])]));
  }

  private async publish(
    tx: SqlExecutor,
    type: string,
    id: string,
    unit: string,
    status: TicketStatus,
  ) {
    await this.outbox.publish(
      {
        type,
        aggregateType: 'ticket',
        aggregateId: id,
        payload: { ticketId: id, unit, status },
      },
      tx,
    );
  }

  private overdue(row: TicketRow, now: Date): boolean {
    return (
      row.due_at !== null &&
      row.paused_at === null &&
      isLive(row.status) &&
      new Date(row.due_at).getTime() <= now.getTime()
    );
  }

  private withinReopen(row: TicketRow, days: number, now: Date): boolean {
    return (
      days > 0 &&
      row.resolved_at !== null &&
      now.getTime() <= new Date(row.resolved_at).getTime() + days * DAY_MS
    );
  }

  private summary(row: TicketRow): TicketSummary {
    return {
      id: row.id,
      number: Number(row.number),
      kind: row.kind,
      topicCode: row.topic_code,
      subject: row.subject,
      status: row.status,
      unit: row.unit,
      channel: row.requester_channel,
      openedAt: iso(row.created_at),
      dueAt: isoOrNull(row.due_at),
      paused: row.paused_at !== null,
      resolvedAt: isoOrNull(row.resolved_at),
      closedAt: isoOrNull(row.closed_at),
    };
  }

  /**
   * The ticket as its requester sees it: no internal message or file is even counted
   * (test 3). Staff get the same with everything (`all`).
   */
  private async requesterView(
    row: TicketRow,
    now: Date,
    mode: 'requester' | 'staff' | 'collection' = 'requester',
  ): Promise<TicketView> {
    const all = mode !== 'requester';
    const onlyPublic = all ? sql`true` : sql`visibility = 'public'`;
    const collection = mode === 'collection';
    const noTreatmentLinks = collection
      ? sql`entity_type NOT IN (${sql.join(
          TREATMENT_LINK_TYPES.map((t) => sql`${t}`),
          sql`, `,
        )})`
      : sql`true`;
    const [links, messages, files] = await Promise.all([
      this.db.execute(sql`
        SELECT entity_type, entity_id, label FROM ticket_links
        WHERE ticket_id = ${row.id} AND ${noTreatmentLinks} ORDER BY created_at, id
      `),
      this.db.execute(sql`
        SELECT m.id, m.author_side, m.visibility, m.body, m.created_at,
          (m.contains_treatment OR f.id IS NOT NULL) AS treatment
        FROM ticket_messages m LEFT JOIN ticket_message_flags f ON f.message_id = m.id
        WHERE m.ticket_id = ${row.id} AND ${all ? sql`true` : sql`m.visibility = 'public'`}
          AND ${collection ? sql`NOT (m.contains_treatment OR f.id IS NOT NULL)` : sql`true`}
        ORDER BY m.created_at, m.id
      `),
      this.db.execute(sql`
        SELECT id, message_id, content_type, size_bytes, contains_treatment, created_at
        FROM ticket_attachments WHERE ticket_id = ${row.id} AND ${onlyPublic}
          AND ${collection ? sql`NOT contains_treatment` : sql`true`}
        ORDER BY created_at, id
      `),
    ]);
    const days = (await this.config.resolve('ticket.reopen_days', {}, now)).value;
    return {
      ...this.summary(row),
      links: links.rows.map((l) => ({
        type: l['entity_type'] as TicketLinkType,
        id: l['entity_id'] as string,
        label: l['label'] as string,
      })),
      messages: messages.rows.map((m) => ({
        id: m['id'] as string,
        side: m['author_side'] as 'requester' | 'staff' | 'respondent',
        ...(all
          ? {
              visibility: m['visibility'] as 'public' | 'internal',
              containsTreatment: Boolean(m['treatment']),
            }
          : {}),
        body: m['body'] as string,
        createdAt: iso(m['created_at']),
      })),
      attachments: files.rows.map((f) => ({
        id: f['id'] as string,
        messageId: (f['message_id'] as string | null) ?? null,
        contentType: f['content_type'] as string,
        sizeBytes: Number(f['size_bytes']),
        containsTreatment: Boolean(f['contains_treatment']),
        createdAt: iso(f['created_at']),
      })),
      canReopen:
        row.status === 'resolved' &&
        row.financial_dispute_id === null &&
        this.withinReopen(row, days, now),
    };
  }
}
