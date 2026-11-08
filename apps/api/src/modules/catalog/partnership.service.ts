import { createHash, createHmac } from 'node:crypto';
import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  HttpException,
  HttpStatus,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import {
  createCenterSchema,
  PARTNERSHIP_DOCUMENTS,
  PARTNERSHIP_FILE_MAX_BYTES,
  requiredDocuments,
  type PartnershipDocument,
  type PartnershipStatus,
  type PartnershipSummary,
  type PartnershipView,
  type PermissionCode,
  type partnershipCodeRequestSchema,
  type partnershipRequestSchema,
} from '@sepehr/contracts';
import { sql } from 'drizzle-orm';
import type { Redis } from 'ioredis';
import type { z } from 'zod';
import { AUDIT_LOG, type Actor, type AuditLog } from '../../common/audit/audit.port';
import { ACCESS_PORT, type AccessPort, type EffectiveAccess } from '../../common/auth/access.port';
import { CENTER_ACCOUNTS, type CenterAccounts } from '../../common/auth/center-accounts.port';
import { assertFreshMfa } from '../../common/auth/fresh-mfa';
import { OTP_CHALLENGE, type OtpChallenge } from '../../common/auth/otp-challenge.port';
import { CONFIG, type ConfigPort } from '../../common/config/config.port';
import { INBOX, type InboxPort } from '../../common/notification/inbox.port';
import {
  NOTIFICATIONS,
  type NotificationsPort,
} from '../../common/notification/notifications.port';
import { MALWARE_SCANNER, type MalwareScanner } from '../../common/security/malware-scanner.port';
import { OBJECT_STORAGE, type ObjectStorage } from '../../common/storage/object-storage.port';
import { DATABASE, type Database } from '../../db/database.module';
import { scannerUnavailable } from '../../infra/clamd';
import { secretKeyFromEnv } from '../../infra/env';
import { detectDocumentType } from '../../infra/file-type';
import { REDIS } from '../../infra/redis.module';
import { storageUnavailable } from '../../infra/s3-storage';
import { CenterService } from './center.service';
import { requireActiveFieldCodes } from './field-codes';
import { PARTNERSHIP_LIMITS, ProofOfWork } from './partnership-guard';

/** Kept apart from login codes: this code proves a partnership applicant's mobile only. */
const CODE_PURPOSE = 'partnership_mobile';
const LINK_SECONDS = 5 * 60;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface UploadedDocument {
  readonly fieldname: string;
  readonly buffer: Buffer;
}

interface RequestRow {
  id: string;
  number: string;
  center_name: string;
  place_kind: string;
  person_type: 'natural' | 'legal';
  city_code: string;
  treatment_field_codes: string[];
  address: string;
  phone: string | null;
  manager_name: string;
  manager_role: string | null;
  mobile: string;
  doctors: { name: string; councilNumber: string; specialty: string | null }[];
  status: PartnershipStatus;
  rejection_reason: string | null;
  reviewed_by: string | null;
  reviewed_at: Date | string | null;
  review_note: string | null;
  approved_by: string | null;
  approved_at: Date | string | null;
  center_id: string | null;
  account_id: string | null;
  created_at: Date | string;
}

const iso = (v: Date | string | null) => (v === null ? null : new Date(v).toISOString());
const tooMany = (retryAfterSeconds: number) =>
  new HttpException({ error: 'rate_limited', retryAfterSeconds }, HttpStatus.TOO_MANY_REQUESTS);

/**
 * Partnership requests (owner 1405/08/10; migration 0110): a center or a doctor asks to join
 * from the public page, its mobile proved by a code and its documents scanned (rule 28). The
 * network specialist reviews it and registers its center as a draft, through the same
 * registration as by hand; the network manager, another person (doc 04), approves it: the
 * center manager's account is made with the proved mobile, given the role on that center only,
 * and its one-time link is sent by SMS. The center is never activated here: activation stays
 * the two-person path of doc 08. Every step is audited and kept in the request's history.
 */
@Injectable()
export class PartnershipService {
  private readonly pow: ProofOfWork;
  private readonly secret: Buffer;

  constructor(
    @Inject(DATABASE) private readonly db: Database,
    @Inject(REDIS) private readonly redis: Redis,
    @Inject(AUDIT_LOG) private readonly audit: AuditLog,
    @Inject(OTP_CHALLENGE) private readonly codes: OtpChallenge,
    @Inject(OBJECT_STORAGE) private readonly storage: ObjectStorage,
    @Inject(MALWARE_SCANNER) private readonly scanner: MalwareScanner,
    @Inject(NOTIFICATIONS) private readonly sms: NotificationsPort,
    @Inject(INBOX) private readonly inbox: InboxPort,
    @Inject(ACCESS_PORT) private readonly access: AccessPort,
    @Inject(CENTER_ACCOUNTS) private readonly accounts: CenterAccounts,
    @Inject(CONFIG) private readonly config: ConfigPort,
    private readonly centers: CenterService,
  ) {
    this.secret = secretKeyFromEnv('AUTH_SECRET');
    this.pow = new ProofOfWork(this.secret, redis);
  }

  // --- the public form --------------------------------------------------------------

  challenge(now = new Date()) {
    return this.pow.issue(now);
  }

  /** One more in a fixed window; 429 past the limit. */
  private async count(key: string, limit: number, seconds: number) {
    const k = `catalog:partnership:${key}`;
    const n = await this.redis.incr(k);
    if (n === 1) await this.redis.expire(k, seconds);
    if (n > limit) throw tooMany(Math.max(await this.redis.ttl(k), 1));
  }

  private async proved(proof: { challenge: string; counter: number }, now: Date) {
    if (!(await this.pow.verify(proof.challenge, proof.counter, now))) {
      throw new BadRequestException({ error: 'proof_of_work_invalid' });
    }
  }

  /** A code to the applicant's mobile, within the daily ceiling of this form's SMS. */
  async sendCode(
    input: z.output<typeof partnershipCodeRequestSchema>,
    ip: string | null,
    now = new Date(),
  ) {
    await this.proved(input.proof, now);
    // A bot filled the hidden field: answered as if sent, nothing sent.
    if (input.website !== '') return { expiresInSeconds: 120, resendAfterSeconds: 60 };
    await this.count(
      `codes-day:${now.toISOString().slice(0, 10)}`,
      PARTNERSHIP_LIMITS.codesPerDay,
      86_400,
    );
    return this.codes.send(input.mobile, CODE_PURPOSE, { ip }, now);
  }

  private ipHash(ip: string | null) {
    return ip === null
      ? null
      : createHmac('sha256', this.secret).update(`partnership-ip\u0000${ip}`).digest('base64url');
  }

  /**
   * The request with its documents: the proof, the limits, the code, then each file scanned
   * and its real type checked before anything is kept. 400 names the first problem.
   */
  async submit(
    input: z.output<typeof partnershipRequestSchema>,
    files: readonly UploadedDocument[],
    ip: string | null,
    now = new Date(),
  ): Promise<{ number: number }> {
    await this.proved(input.proof, now);
    if (input.website !== '') throw new BadRequestException({ error: 'request_refused' });
    if (ip) await this.count(`submit-ip:${ip}`, PARTNERSHIP_LIMITS.submitsPerIpPerHour, 3600);
    await this.count(
      `submit-mobile:${input.mobile}`,
      PARTNERSHIP_LIMITS.submitsPerMobilePerDay,
      86_400,
    );

    const byKind = new Map<PartnershipDocument, Buffer>();
    for (const f of files) {
      const kind = PARTNERSHIP_DOCUMENTS.find((k) => k === f.fieldname);
      if (!kind || byKind.has(kind)) throw new BadRequestException({ error: 'unexpected_file' });
      if (f.buffer.length === 0 || f.buffer.length > PARTNERSHIP_FILE_MAX_BYTES) {
        throw new BadRequestException({ error: 'file_too_large', kind });
      }
      byKind.set(kind, f.buffer);
    }
    for (const kind of requiredDocuments(input.personType)) {
      if (!byKind.has(kind)) throw new BadRequestException({ error: 'document_required', kind });
    }
    if (input.personType === 'natural' && byKind.has('gazette')) {
      throw new BadRequestException({ error: 'unexpected_file' });
    }
    await this.db.transaction((tx) => requireActiveFieldCodes(tx, input.treatmentFieldCodes));

    // The code last: a wrong one counts toward the mobile's lockout (identity policy).
    await this.codes.verify(input.mobile, CODE_PURPOSE, input.code, { ip }, now);

    if (!this.storage.configured) throw storageUnavailable();
    if (!this.scanner.configured) throw scannerUnavailable();
    const checked: { kind: PartnershipDocument; buffer: Buffer; mime: string }[] = [];
    for (const [kind, buffer] of byKind) {
      const scan = await this.scanner.scan(buffer);
      if (!scan.clean) throw new BadRequestException({ error: 'file_infected', kind });
      const mime = detectDocumentType(buffer);
      if (!mime) throw new BadRequestException({ error: 'unsupported_type', kind });
      checked.push({ kind, buffer, mime });
    }

    const id = (await this.db.execute(sql`SELECT uuidv7() AS id`)).rows[0]?.['id'] as string;
    for (const doc of checked) {
      await this.storage.put('private', `partnership/${id}/${doc.kind}`, doc.buffer, doc.mime);
    }
    const number = await this.db.transaction(async (tx) => {
      const row = (
        await tx.execute(sql`
          INSERT INTO partnership_requests (id, center_name, place_kind, person_type, city_code,
            treatment_field_codes, address, phone, manager_name, manager_role, mobile,
            mobile_verified_at, doctors, ip_hash, created_at)
          VALUES (${id}, ${input.centerName}, ${input.placeKind}, ${input.personType},
            ${input.cityCode}, ${pgArray(input.treatmentFieldCodes)}::text[], ${input.address},
            ${input.phone}, ${input.managerName}, ${input.managerRole}, ${input.mobile},
            ${now.toISOString()}, ${JSON.stringify(input.doctors)}::jsonb, ${this.ipHash(ip)},
            ${now.toISOString()})
          RETURNING number
        `)
      ).rows[0];
      for (const doc of checked) {
        await tx.execute(sql`
          INSERT INTO partnership_request_documents (request_id, kind, object_key, content_type,
            size_bytes, sha256)
          VALUES (${id}, ${doc.kind}, ${`partnership/${id}/${doc.kind}`}, ${doc.mime},
            ${doc.buffer.length}, ${createHash('sha256').update(doc.buffer).digest('hex')})
        `);
      }
      await this.event(tx, id, 'received', null, null);
      const n = Number(row?.['number']);
      await this.audit.record(
        {
          actor: { accountId: null, sessionId: null, ip, roles: [] },
          action: 'catalog.partnership_received',
          entityType: 'partnership_request',
          entityId: id,
          after: { number: n, centerName: input.centerName, cityCode: input.cityCode },
        },
        tx,
      );
      await this.sms.send(
        {
          templateCode: 'partnership.received',
          audience: 'staff',
          mobile: input.mobile,
          values: { case_number: String(n) },
          idempotencyKey: `partnership.received:${id}`,
        },
        tx,
      );
      await this.inbox.notifyHolders(
        'catalog.review_partnership',
        {
          kind: 'partnership.received',
          title: 'درخواست همکاری تازه',
          body: `درخواست ${String(n)} برای بررسی رسیده است.`,
          linkHref: `/partnership/${id}`,
          dedupeKey: `partnership.received:${id}`,
        },
        tx,
      );
      return n;
    });
    return { number };
  }

  // --- the queue ----------------------------------------------------------------------

  private need(access: EffectiveAccess, ...any: PermissionCode[]) {
    if (!any.some((p) => access.permissions.has(p))) {
      throw new ForbiddenException({ error: 'permission_required' });
    }
  }

  private async event(
    tx: { execute: Database['execute'] },
    requestId: string,
    action: string,
    actorId: string | null,
    note: string | null,
  ) {
    await tx.execute(sql`
      INSERT INTO partnership_request_events (request_id, action, actor_account_id, note)
      VALUES (${requestId}, ${action}, ${actorId}, ${note})
    `);
  }

  async list(access: EffectiveAccess, status?: PartnershipStatus): Promise<PartnershipSummary[]> {
    this.need(access, 'catalog.review_partnership', 'catalog.approve_partnership');
    const rows = (
      await this.db.execute(sql`
        SELECT id, number, center_name, place_kind, city_code, manager_name, status, created_at
        FROM partnership_requests
        WHERE deleted_at IS NULL ${status ? sql`AND status = ${status}` : sql``}
        ORDER BY created_at DESC LIMIT 200
      `)
    ).rows as unknown as RequestRow[];
    return rows.map((r) => this.summary(r));
  }

  private summary(r: RequestRow): PartnershipSummary {
    return {
      id: r.id,
      number: Number(r.number),
      centerName: r.center_name,
      placeKind: r.place_kind as PartnershipSummary['placeKind'],
      cityCode: r.city_code,
      managerName: r.manager_name,
      status: r.status,
      createdAt: new Date(r.created_at).toISOString(),
    };
  }

  private async row(id: string, forUpdate?: { execute: Database['execute'] }) {
    if (!UUID.test(id)) throw new NotFoundException({ error: 'request_not_found' });
    const row = (
      await (forUpdate ?? this.db).execute(sql`
        SELECT * FROM partnership_requests WHERE id = ${id} AND deleted_at IS NULL
        ${forUpdate ? sql`FOR UPDATE` : sql``}
      `)
    ).rows[0] as RequestRow | undefined;
    if (!row) throw new NotFoundException({ error: 'request_not_found' });
    return row;
  }

  async view(access: EffectiveAccess, id: string): Promise<PartnershipView> {
    this.need(access, 'catalog.review_partnership', 'catalog.approve_partnership');
    const r = await this.row(id);
    const [docs, events] = await Promise.all([
      this.db.execute(sql`
        SELECT id, kind, content_type, size_bytes FROM partnership_request_documents
        WHERE request_id = ${id} ORDER BY kind
      `),
      this.db.execute(sql`
        SELECT action, actor_account_id, note, created_at FROM partnership_request_events
        WHERE request_id = ${id} ORDER BY created_at, id
      `),
    ]);
    return {
      ...this.summary(r),
      personType: r.person_type,
      treatmentFieldCodes: r.treatment_field_codes,
      address: r.address,
      phone: r.phone,
      managerRole: r.manager_role,
      mobileLastFour: r.mobile.slice(-4),
      doctors: r.doctors,
      rejectionReason: r.rejection_reason,
      reviewedBy: r.reviewed_by,
      reviewedAt: iso(r.reviewed_at),
      reviewNote: r.review_note,
      approvedBy: r.approved_by,
      approvedAt: iso(r.approved_at),
      centerId: r.center_id,
      accountId: r.account_id,
      documents: docs.rows.map((d) => ({
        id: d['id'] as string,
        kind: d['kind'] as PartnershipDocument,
        contentType: d['content_type'] as string,
        sizeBytes: Number(d['size_bytes']),
      })),
      events: events.rows.map((e) => ({
        action: e['action'] as string,
        actorAccountId: (e['actor_account_id'] as string | null) ?? null,
        note: (e['note'] as string | null) ?? null,
        createdAt: new Date(e['created_at'] as string).toISOString(),
      })),
    };
  }

  /** A short-lived link to a document (rule 28), its view recorded (doc 04 §7). */
  async documentLink(actor: Actor, access: EffectiveAccess, id: string, documentId: string) {
    this.need(access, 'catalog.review_partnership', 'catalog.approve_partnership');
    if (!UUID.test(documentId)) throw new NotFoundException({ error: 'document_not_found' });
    const doc = (
      await this.db.execute(sql`
        SELECT object_key FROM partnership_request_documents
        WHERE id = ${documentId} AND request_id = ${id}
      `)
    ).rows[0];
    if (!doc) throw new NotFoundException({ error: 'document_not_found' });
    await this.audit.recordView(actor, 'partnership_document', documentId);
    return {
      url: await this.storage.signedUrl(doc['object_key'] as string, LINK_SECONDS),
      expiresInSeconds: LINK_SECONDS,
    };
  }

  /**
   * The specialist's review: the center registered as a draft by the same registration as by
   * hand, with the identifier read from the documents; then the managers are told.
   */
  async review(
    actor: Actor,
    access: EffectiveAccess,
    id: string,
    input: { identifier: string; licenseNumber: string | null; note: string },
    now = new Date(),
  ): Promise<PartnershipView> {
    this.need(access, 'catalog.review_partnership');
    const r = await this.row(id);
    if (r.status !== 'pending') throw new ConflictException({ error: 'request_not_pending' });
    const parsed = createCenterSchema.safeParse({
      personType: r.person_type,
      identifier: input.identifier,
      cityCode: r.city_code,
      name: r.center_name,
      address: r.address,
      ...(r.phone ? { phone: r.phone } : {}),
      ...(input.licenseNumber ? { licenseNumber: input.licenseNumber } : {}),
      treatmentFieldCodes: r.treatment_field_codes,
    });
    if (!parsed.success) throw new BadRequestException({ error: 'invalid_identifier' });
    const center = await this.centers.create(actor, access, parsed.data);
    await this.db.transaction(async (tx) => {
      const locked = await this.row(id, tx);
      if (locked.status !== 'pending')
        throw new ConflictException({ error: 'request_not_pending' });
      await tx.execute(sql`
        UPDATE partnership_requests SET status = 'reviewed', reviewed_by = ${actor.accountId},
          reviewed_at = ${now.toISOString()}, review_note = ${input.note}, center_id = ${center.id}
        WHERE id = ${id}
      `);
      await this.event(tx, id, 'center_created', actor.accountId, center.name);
      await this.event(tx, id, 'reviewed', actor.accountId, input.note);
      await this.audit.record(
        {
          actor,
          action: 'catalog.partnership_reviewed',
          entityType: 'partnership_request',
          entityId: id,
          after: { status: 'reviewed', centerId: center.id },
          reason: input.note,
        },
        tx,
      );
      await this.inbox.notifyHolders(
        'catalog.approve_partnership',
        {
          kind: 'partnership.reviewed',
          title: 'درخواست همکاری منتظر تأیید نهایی',
          body: `درخواست ${String(Number(r.number))} بررسی شد و تأیید نفر دوم را می‌خواهد.`,
          linkHref: `/partnership/${id}`,
          dedupeKey: `partnership.reviewed:${id}`,
        },
        tx,
      );
    });
    return this.view(access, id);
  }

  /**
   * The manager's approval, never the reviewer's: the account with the proved mobile, the
   * center manager's role on that center only, and the one-time link by SMS. The center stays
   * a draft until its own two-person activation.
   */
  async approve(
    actor: Actor,
    access: EffectiveAccess,
    id: string,
    note: string,
    now = new Date(),
  ): Promise<PartnershipView> {
    this.need(access, 'catalog.approve_partnership');
    await assertFreshMfa(this.config, actor, now);
    const r = await this.row(id);
    if (r.status !== 'reviewed') throw new ConflictException({ error: 'request_not_reviewed' });
    if (r.reviewed_by === actor.accountId) {
      throw new ForbiddenException({ error: 'second_person_required' });
    }
    if (!r.center_id) throw new ConflictException({ error: 'request_without_center' });
    const node = (await this.db.execute(sql`SELECT node_id FROM centers WHERE id = ${r.center_id}`))
      .rows[0]?.['node_id'] as string | undefined;
    if (!node) throw new ConflictException({ error: 'request_without_center' });

    const number = Number(r.number);
    const username = `c${String(number)}`;
    const account =
      r.account_id === null
        ? await this.accounts.provision(
            actor,
            {
              username,
              displayName: r.manager_name,
              mobile: r.mobile,
              linkOrigin: panelOrigin(),
              requestNumber: number,
            },
            now,
          )
        : null;
    const accountId = account?.accountId ?? r.account_id ?? '';
    await this.access.grantCenterManager(actor, {
      accountId,
      centerNodeId: node,
      reason: `درخواست همکاری ${String(number)}`,
    });
    await this.db.transaction(async (tx) => {
      const locked = await this.row(id, tx);
      if (locked.status !== 'reviewed')
        throw new ConflictException({ error: 'request_not_reviewed' });
      await tx.execute(sql`
        UPDATE partnership_requests SET status = 'approved', approved_by = ${actor.accountId},
          approved_at = ${now.toISOString()}, account_id = ${accountId}
        WHERE id = ${id}
      `);
      await this.event(tx, id, 'account_created', actor.accountId, username);
      await this.event(tx, id, 'approved', actor.accountId, note);
      if (account) {
        // The link went by the identity module's own SMS; its text is recorded nowhere.
        await this.event(tx, id, 'link_sent', actor.accountId, null);
      }
      await this.audit.record(
        {
          actor,
          action: 'catalog.partnership_approved',
          entityType: 'partnership_request',
          entityId: id,
          after: { status: 'approved', accountId, centerId: r.center_id },
          reason: note,
        },
        tx,
      );
    });
    return this.view(access, id);
  }

  /** Refused with a reason, at either step; the applicant is told by SMS. */
  async reject(
    actor: Actor,
    access: EffectiveAccess,
    id: string,
    reason: string,
    now = new Date(),
  ): Promise<PartnershipView> {
    const r = await this.row(id);
    if (r.status === 'pending') this.need(access, 'catalog.review_partnership');
    else if (r.status === 'reviewed') {
      this.need(access, 'catalog.approve_partnership');
      if (r.reviewed_by === actor.accountId) {
        throw new ForbiddenException({ error: 'second_person_required' });
      }
    } else throw new ConflictException({ error: 'request_decided' });
    await this.db.transaction(async (tx) => {
      const locked = await this.row(id, tx);
      if (locked.status !== r.status) throw new ConflictException({ error: 'request_decided' });
      await tx.execute(sql`
        UPDATE partnership_requests SET status = 'rejected', rejection_reason = ${reason}
          ${r.status === 'pending' ? sql`, reviewed_by = ${actor.accountId}, reviewed_at = ${now.toISOString()}` : sql``}
        WHERE id = ${id}
      `);
      await this.event(tx, id, 'rejected', actor.accountId, reason);
      await this.audit.record(
        {
          actor,
          action: 'catalog.partnership_rejected',
          entityType: 'partnership_request',
          entityId: id,
          before: { status: r.status },
          after: { status: 'rejected' },
          reason,
        },
        tx,
      );
      await this.sms.send(
        {
          templateCode: 'partnership.rejected',
          audience: 'staff',
          mobile: r.mobile,
          values: { case_number: String(Number(r.number)), reason },
          idempotencyKey: `partnership.rejected:${id}`,
        },
        tx,
      );
    });
    return this.view(access, id);
  }
}

/** A text[] literal (a bound parameter) of codes the schema checked to be `[a-z][a-z0-9_]*`. */
const pgArray = (codes: readonly string[]) => `{${codes.join(',')}}`;

/** Where the center panel is: PANEL_WEB_ORIGIN, else the first of WEB_ORIGINS. */
function panelOrigin(): string {
  const own = process.env['PANEL_WEB_ORIGIN'];
  if (own) return own.replace(/\/$/, '');
  const first = (process.env['WEB_ORIGINS'] ?? '').split(',')[0]?.trim() ?? '';
  return first.replace(/\/$/, '');
}
