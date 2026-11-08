import { createHash } from 'node:crypto';
import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import type { ConsentRole, CreditDocumentChecklist } from '@sepehr/contracts';
import { and, asc, eq, inArray, isNull, ne, sql } from 'drizzle-orm';
import type { EffectiveAccess } from '../../common/auth/access.port';
import { AUDIT_LOG, type Actor, type AuditLog } from '../../common/audit/audit.port';
import { CONFIG, type ConfigPort } from '../../common/config/config.port';
import { OUTBOX, type OutboxPort } from '../../common/events/outbox.port';
import { MALWARE_SCANNER, type MalwareScanner } from '../../common/security/malware-scanner.port';
import { OBJECT_STORAGE, type ObjectStorage } from '../../common/storage/object-storage.port';
import { DATABASE, type Database } from '../../db/database.module';
import { scannerUnavailable } from '../../infra/clamd';
import { detectDocumentType } from '../../infra/file-type';
import { storageUnavailable } from '../../infra/s3-storage';
import { CreditApplicationService } from './credit-application.service';
import {
  creditApplications,
  creditDocuments,
  creditGuarantors,
  scoreSheets,
} from './credit.schema';

type ApplicationRow = typeof creditApplications.$inferSelect;
type DocumentRow = typeof creditDocuments.$inferSelect;
type Item = CreditDocumentChecklist['items'][number];

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** States in which documents are uploaded: from the draft to the decision. */
const UPLOADABLE = ['draft', 'incomplete', 'ready_for_review', 'scoring', 'manual_review'] as const;
const notFound = () => new NotFoundException({ error: 'credit_document_not_found' });

/** A person of an application whose documents are asked: the borrower, or a guarantor. */
interface Subject {
  readonly role: ConsentRole;
  readonly personId: string;
  readonly guarantorId: string | null;
}

/**
 * Documents of a credit application (task 3-5 part C; doc 10 §4). Each person uploads
 * their own: the real type from the bytes (rule 28), scanned by ClamAV, stored in private
 * space under a generated key, seen only through a short signed link, and every view in
 * the access log (doc 04 §7). The case-completion specialist accepts or rejects each with
 * a reason; a rejection is told to its owner by SMS (the worker's CreditNotifier).
 */
@Injectable()
export class CreditDocumentService {
  constructor(
    @Inject(DATABASE) private readonly db: Database,
    @Inject(AUDIT_LOG) private readonly audit: AuditLog,
    @Inject(OUTBOX) private readonly outbox: OutboxPort,
    @Inject(CONFIG) private readonly config: ConfigPort,
    @Inject(OBJECT_STORAGE) private readonly storage: ObjectStorage,
    @Inject(MALWARE_SCANNER) private readonly scanner: MalwareScanner,
    private readonly applications: CreditApplicationService,
  ) {}

  // --- the applicant's own -----------------------------------------------------------

  async upload(
    actor: Actor,
    accountId: string,
    id: string,
    fields: { role: ConsentRole; itemCode: string },
    file: { buffer: Buffer; size: number } | undefined,
  ) {
    if (!file) throw new BadRequestException({ error: 'file_required' });
    if (!this.storage.configured) throw storageUnavailable();
    if (!this.scanner.configured) throw scannerUnavailable();
    const app = await this.appRow(id);
    if (!(UPLOADABLE as readonly string[]).includes(app.status)) {
      throw new ConflictException({ error: 'wrong_status', status: app.status });
    }
    const subject = (await this.ownSubjects(accountId, app)).find((s) => s.role === fields.role);
    if (!subject) throw new NotFoundException({ error: 'credit_application_not_found' });
    const { checklist, versionId } = await this.checklistOf(app);
    const item = (await this.itemsFor(app, checklist, subject)).find(
      (i) => i.code === fields.itemCode,
    );
    if (!item)
      throw new BadRequestException({ error: 'not_in_checklist', itemCode: fields.itemCode });

    const policy = (await this.config.resolve('credit.document_policy')).value;
    if (file.size > policy.maxBytes) {
      throw new BadRequestException({ error: 'file_too_large', limit: policy.maxBytes });
    }
    // Every file is scanned, whatever it claims to be; then only a PDF or photo is kept.
    const scan = await this.scanner.scan(file.buffer);
    if (!scan.clean) throw new BadRequestException({ error: 'file_infected' });
    const mime = detectDocumentType(file.buffer);
    if (!mime) throw new BadRequestException({ error: 'unsupported_type' });

    const idRow = await this.db.execute(sql`SELECT uuidv7() AS id`);
    const documentId = idRow.rows[0]?.['id'] as string;
    const storageKey = `credit-documents/${app.id}/${documentId}`;
    await this.storage.put('private', storageKey, file.buffer, mime);

    const row = await this.db.transaction(async (tx) => {
      const [current] = await tx
        .select()
        .from(creditDocuments)
        .where(
          and(
            eq(creditDocuments.creditApplicationId, app.id),
            eq(creditDocuments.personId, subject.personId),
            eq(creditDocuments.role, subject.role),
            eq(creditDocuments.itemCode, item.code),
            inArray(creditDocuments.status, ['submitted', 'accepted']),
          ),
        )
        .for('update');
      if (current?.status === 'accepted')
        throw new ConflictException({ error: 'document_already_accepted' });
      if (current) {
        await tx
          .update(creditDocuments)
          .set({ status: 'superseded' })
          .where(eq(creditDocuments.id, current.id));
      }
      const [made] = await tx
        .insert(creditDocuments)
        .values({
          id: documentId,
          creditApplicationId: app.id,
          personId: subject.personId,
          role: subject.role,
          guarantorId: subject.guarantorId,
          itemCode: item.code,
          checklistVersionId: versionId,
          storageKey,
          mime,
          sizeBytes: file.size,
          sha256: createHash('sha256').update(file.buffer).digest('hex'),
          uploadedBy: accountId,
        })
        .returning();
      if (!made) throw new Error('credit document insert returned nothing');
      await this.audit.record(
        {
          actor,
          action: 'credit.document_uploaded',
          entityType: 'credit_application',
          entityId: app.id,
          after: {
            documentId: made.id,
            itemCode: made.itemCode,
            role: made.role,
            supersedes: current?.id ?? null,
          },
        },
        tx,
      );
      return made;
    });
    return documentView(row);
  }

  /** The caller's own checklists on this application (as borrower and/or guarantor). */
  async mine(accountId: string, id: string) {
    const app = await this.appRow(id);
    const subjects = await this.ownSubjects(accountId, app);
    if (subjects.length === 0)
      throw new NotFoundException({ error: 'credit_application_not_found' });
    return { people: await this.checklistsFor(app, subjects) };
  }

  async ownLink(actor: Actor, accountId: string, id: string, documentId: string) {
    const app = await this.appRow(id);
    const subjects = await this.ownSubjects(accountId, app);
    const doc = await this.documentRow(app.id, documentId);
    if (!subjects.some((s) => s.personId === doc.personId && s.role === doc.role)) throw notFound();
    return this.link(actor, doc);
  }

  // --- staff ------------------------------------------------------------------------

  async forStaff(access: EffectiveAccess, id: string) {
    this.require(access, 'credit.read_applications');
    const app = await this.applications.staffApplication(access, id);
    return { people: await this.checklistsFor(app, await this.subjectsOf(app)) };
  }

  async staffLink(actor: Actor, access: EffectiveAccess, id: string, documentId: string) {
    this.require(access, 'credit.read_applications');
    const app = await this.applications.staffApplication(access, id);
    return this.link(actor, await this.documentRow(app.id, documentId));
  }

  async decide(
    actor: Actor,
    access: EffectiveAccess,
    id: string,
    documentId: string,
    decision: { decision: 'accept' } | { decision: 'reject'; reason: string },
    now = new Date(),
  ) {
    this.require(access, 'credit.complete_applications');
    const app = await this.applications.staffApplication(access, id);
    const row = await this.db.transaction(async (tx) => {
      const [doc] = await tx
        .select()
        .from(creditDocuments)
        .where(
          and(eq(creditDocuments.id, documentId), eq(creditDocuments.creditApplicationId, app.id)),
        )
        .for('update');
      if (!doc) throw notFound();
      if (doc.status !== 'submitted')
        throw new ConflictException({ error: 'already_decided', status: doc.status });
      const accepted = decision.decision === 'accept';
      const [decided] = await tx
        .update(creditDocuments)
        .set({
          status: accepted ? 'accepted' : 'rejected',
          reason: accepted ? null : decision.reason,
          decidedBy: actor.accountId,
          decidedAt: now,
        })
        .where(eq(creditDocuments.id, doc.id))
        .returning();
      if (!decided) throw new Error('credit document decision returned nothing');
      await this.audit.record(
        {
          actor,
          action: accepted ? 'credit.document_accepted' : 'credit.document_rejected',
          entityType: 'credit_application',
          entityId: app.id,
          after: { documentId: doc.id, itemCode: doc.itemCode },
          reason: accepted ? null : decision.reason,
        },
        tx,
      );
      if (!accepted) {
        await this.outbox.publish(
          {
            type: 'credit.document_rejected',
            aggregateType: 'credit_application',
            aggregateId: app.id,
            payload: {
              creditApplicationId: app.id,
              caseId: app.caseId,
              proformaId: app.proformaId,
              documentId: doc.id,
            },
          },
          tx,
        );
      }
      return decided;
    });
    return documentView(row);
  }

  // --- helpers ----------------------------------------------------------------------

  /**
   * Every required item not yet accepted, of the borrower and of each guarantor, with the
   * items of their job once a sheet names it (task 3-6: guarantors' documents are checked
   * at the decision, task 3-5 decision). `document:<role>:<item>` for the borrower,
   * `document:guarantor:<guarantorId>:<item>` for a guarantor.
   */
  async missingRequired(app: ApplicationRow): Promise<string[]> {
    const people = await this.checklistsFor(app, await this.subjectsOf(app));
    return people.flatMap((p) =>
      p.items
        .filter((i) => i.required && i.document?.status !== 'accepted')
        .map((i) =>
          p.guarantorId === null
            ? `document:borrower:${i.itemCode}`
            : `document:guarantor:${p.guarantorId}:${i.itemCode}`,
        ),
    );
  }

  private async link(actor: Actor, doc: DocumentRow) {
    if (!this.storage.configured) throw storageUnavailable();
    const policy = (await this.config.resolve('credit.document_policy')).value;
    const url = await this.storage.signedUrl(doc.storageKey, policy.signedUrlSeconds);
    // Every view of a document is logged (doc 04 §7, doc 10 §4).
    await this.audit.recordView(actor, 'credit_document', doc.id);
    return { url, expiresInSeconds: policy.signedUrlSeconds };
  }

  /** The checklist the application is locked to, or today's before submission. */
  private async checklistOf(app: ApplicationRow) {
    const resolved = app.checklistVersionId
      ? await this.config.getVersion('credit.document_checklist', app.checklistVersionId)
      : await this.config.resolve('credit.document_checklist');
    return { checklist: resolved.value, versionId: resolved.versionId };
  }

  /** The items asked of this person: by role, and by job once their sheet says it. */
  private async itemsFor(
    app: ApplicationRow,
    checklist: CreditDocumentChecklist,
    subject: Subject,
  ): Promise<Item[]> {
    const [sheet] = await this.db
      .select({ answers: scoreSheets.answers })
      .from(scoreSheets)
      .where(
        and(
          eq(scoreSheets.creditApplicationId, app.id),
          eq(scoreSheets.personId, subject.personId),
          eq(scoreSheets.subject, subject.role),
          isNull(scoreSheets.supersededBy),
        ),
      );
    const job = (sheet?.answers as Record<string, string> | undefined)?.['job'];
    return checklist.items.filter(
      (i) =>
        i.roles.includes(subject.role) &&
        (i.jobs === null || (job !== undefined && i.jobs.includes(job))),
    );
  }

  private async checklistsFor(app: ApplicationRow, subjects: readonly Subject[]) {
    const { checklist } = await this.checklistOf(app);
    const current = await this.db
      .select()
      .from(creditDocuments)
      .where(
        and(
          eq(creditDocuments.creditApplicationId, app.id),
          ne(creditDocuments.status, 'superseded'),
        ),
      )
      .orderBy(asc(creditDocuments.createdAt));
    const people = [];
    for (const s of subjects) {
      const items = await this.itemsFor(app, checklist, s);
      people.push({
        role: s.role,
        guarantorId: s.guarantorId,
        items: items.map((i) => {
          // The latest non-superseded upload: submitted or accepted, else the last rejection.
          const docs = current.filter(
            (d) => d.personId === s.personId && d.role === s.role && d.itemCode === i.code,
          );
          const doc = docs.find((d) => d.status !== 'rejected') ?? docs.at(-1) ?? null;
          return {
            itemCode: i.code,
            title: i.title,
            role: s.role,
            required: i.required,
            document: doc ? documentView(doc) : null,
          };
        }),
      });
    }
    return people;
  }

  private async subjectsOf(app: ApplicationRow): Promise<Subject[]> {
    const guarantors = await this.db
      .select()
      .from(creditGuarantors)
      .where(
        and(
          eq(creditGuarantors.creditApplicationId, app.id),
          ne(creditGuarantors.status, 'withdrawn'),
        ),
      )
      .orderBy(asc(creditGuarantors.createdAt));
    return [
      { role: 'borrower', personId: app.borrowerPersonId, guarantorId: null },
      ...guarantors.map((g) => ({
        role: 'guarantor' as const,
        personId: g.personId,
        guarantorId: g.id,
      })),
    ];
  }

  private async ownSubjects(accountId: string, app: ApplicationRow): Promise<Subject[]> {
    const persons = await this.applications.personsOf(accountId);
    return (await this.subjectsOf(app)).filter((s) => persons.includes(s.personId));
  }

  private async appRow(id: string): Promise<ApplicationRow> {
    if (!UUID.test(id)) throw new NotFoundException({ error: 'credit_application_not_found' });
    const [app] = await this.db
      .select()
      .from(creditApplications)
      .where(eq(creditApplications.id, id));
    if (!app) throw new NotFoundException({ error: 'credit_application_not_found' });
    return app;
  }

  private async documentRow(appId: string, documentId: string): Promise<DocumentRow> {
    if (!UUID.test(documentId)) throw notFound();
    const [doc] = await this.db
      .select()
      .from(creditDocuments)
      .where(
        and(eq(creditDocuments.id, documentId), eq(creditDocuments.creditApplicationId, appId)),
      );
    if (!doc) throw notFound();
    return doc;
  }

  private require(
    access: EffectiveAccess,
    permission: 'credit.read_applications' | 'credit.complete_applications',
  ) {
    if (!access.permissions.has(permission))
      throw new ForbiddenException({ error: 'permission_required', permission });
  }
}

function documentView(d: DocumentRow) {
  return {
    id: d.id,
    itemCode: d.itemCode,
    role: d.role,
    status: d.status,
    mime: d.mime,
    sizeBytes: d.sizeBytes,
    reason: d.reason,
    uploadedAt: d.createdAt.toISOString(),
    decidedAt: d.decidedAt?.toISOString() ?? null,
  };
}
