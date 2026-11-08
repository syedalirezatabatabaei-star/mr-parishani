import { FINANCIAL_STEP_UP, type FinancialStepUp } from '../../common/auth/step-up.port';
import {
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import type { EffectiveAccess } from '../../common/auth/access.port';
import { ACCOUNT_DIRECTORY, type AccountDirectory } from '../../common/auth/account-directory.port';
import { assertFreshMfa } from '../../common/auth/fresh-mfa';
import { AUDIT_LOG, type Actor, type AuditLog } from '../../common/audit/audit.port';
import { CONFIG, type ConfigPort } from '../../common/config/config.port';
import { DATABASE, type Database } from '../../db/database.module';
import { lastFour } from '../../security/blind-index';
import { eq } from 'drizzle-orm';
import { personMobileDecisions, personMobileProposals } from './lead.schema';
import { requirePermission, systemActor, UUID, type Tx } from './lead.shared';
import { PersonMobiles, type PersonMobileRow } from './person-mobiles';
import { PersonService } from './person.service';

/** One pending mobile as the holder of a proved mobile of the same Person sees it. */
export interface PendingForOwner {
  readonly id: string;
  /** The last four digits only: enough to recognize it. */
  readonly mobileLast4: string;
  readonly addedAt: string;
  readonly expiresAt: string | null;
}

/** What a patient sees of pending mobiles: their own, and those awaiting their decision. */
export interface MyPersonMobiles {
  /** This login's mobile is pending: it sees nothing of the Person until approved. */
  readonly ownMobilePending: boolean;
  readonly awaitingDecision: PendingForOwner[];
}

/** The first of the two staff (owner 1405/07/23): who proposed approving, and when. */
export interface ProposalForStaff {
  readonly proposedBy: string;
  readonly proposedAt: string;
}

/**
 * One pending mobile in the staff queue: the last four digits only, masked here on the server
 * (owner 1405/07/23); the whole number only on its decision page, {@link MobileForStaff}.
 */
export interface PendingForStaff {
  readonly id: string;
  readonly personId: string;
  readonly mobileLast4: string;
  readonly addedVia: PersonMobileRow['addedVia'];
  readonly addedBy: string | null;
  readonly addedAt: string;
  readonly expiresAt: string | null;
  /** Whether a proved mobile of the Person can decide in their own panel (method الف). */
  readonly hasProvedMobile: boolean;
  readonly proposal: ProposalForStaff | null;
}

/** The decision page: the whole number, each view of it recorded (access_logs). */
export interface MobileForStaff extends PendingForStaff {
  readonly mobile: string;
  readonly proposalDetail: (ProposalForStaff & { reason: string; evidence: string }) | null;
}

type ProposalRow = typeof personMobileProposals.$inferSelect;

type Decision = 'approved' | 'rejected';
type Method = 'owner_panel' | 'staff' | 'expiry' | 'import_cancelled';

const EXPIRY_BATCH = 100;
const EXPIRY_ACTOR = systemActor('lead.person_mobile_expiry');

/**
 * Deciding on a pending mobile (task 9-3, go-live blocker م۵; owner 1405/07/19):
 *
 * - (الف) in the panel of the holder of a proved mobile of the same Person, after their OTP
 *   login: the login itself is the code to that mobile. No code is sent by SMS, which the new
 *   mobile's holder could talk out of them;
 * - (ب) staff with `lead.approve_person_mobile`, re-authenticated (R1), never the account that
 *   added it, and by two people (owner 1405/07/23, migration 0085): the first proposes with
 *   the evidence seen, a second approves; refusing takes one. The queue shows the last four
 *   digits only; the whole number is on the decision page, each view recorded;
 * - at the deadline locked on the row (`lead.person_mobile_pending_days`), refused by itself.
 *
 * Each decision is one row of person_mobile_decisions and one audit event, and the Person's
 * proved mobiles are told (R2). Approved, the mobile stands for the Person; refused, it is
 * soft-deleted and free for a Person of its own.
 */
@Injectable()
export class PersonMobileApprovalService {
  constructor(
    @Inject(DATABASE) private readonly db: Database,
    @Inject(AUDIT_LOG) private readonly audit: AuditLog,
    @Inject(CONFIG) private readonly config: ConfigPort,
    @Inject(ACCOUNT_DIRECTORY) private readonly accounts: AccountDirectory,
    private readonly persons: PersonService,
    @Inject(FINANCIAL_STEP_UP) private readonly stepUp: FinancialStepUp,
  ) {}

  // --- (الف) the holder of a proved mobile, in their own panel ------------------------------

  async mine(accountId: string): Promise<MyPersonMobiles> {
    const owner = await this.ownerOf(this.db, accountId);
    if (owner.kind === 'pending') return { ownMobilePending: true, awaitingDecision: [] };
    if (owner.kind === 'none') return { ownMobilePending: false, awaitingDecision: [] };
    const pending = await PersonMobiles.pendingOf(this.db, owner.personIds);
    return {
      ownMobilePending: false,
      awaitingDecision: pending.map((m) => ({
        id: m.id,
        mobileLast4: lastFour(m.mobile),
        addedAt: m.createdAt.toISOString(),
        expiresAt: m.pendingExpiresAt?.toISOString() ?? null,
      })),
    };
  }

  async decideAsOwner(
    actor: Actor,
    accountId: string,
    id: string,
    decision: Decision,
    now = new Date(),
  ): Promise<{ id: string; decision: Decision }> {
    if (!UUID.test(id)) throw notFound();
    return this.db.transaction(async (tx) => {
      const owner = await this.ownerOf(tx, accountId);
      const row = await PersonMobiles.lockPending(tx, id);
      // Another Person's pending mobile is not found, not forbidden (IDOR).
      if (owner.kind !== 'proved' || !row || !owner.personIds.includes(row.personId)) {
        throw notFound();
      }
      if (row.pendingExpiresAt !== null && row.pendingExpiresAt <= now) {
        throw new ConflictException({ error: 'person_mobile_expired' });
      }
      await this.apply(tx, actor, row, decision, 'owner_panel', OWNER_REASON[decision], null, now);
      return { id: row.id, decision };
    });
  }

  // --- (ب) staff -----------------------------------------------------------------------------

  async pendingQueue(access: EffectiveAccess): Promise<PendingForStaff[]> {
    requirePermission(access, 'lead.approve_person_mobile');
    const rows = await PersonMobiles.pendingAll(this.db);
    const out: PendingForStaff[] = [];
    for (const m of rows) out.push(await this.forStaff(this.db, m));
    return out;
  }

  /** The decision page of one pending mobile: its whole number, and this view recorded. */
  async mobileForStaff(actor: Actor, access: EffectiveAccess, id: string): Promise<MobileForStaff> {
    requirePermission(access, 'lead.approve_person_mobile');
    if (!UUID.test(id)) throw notFound();
    const view = await this.db.transaction(async (tx) => {
      const row = await PersonMobiles.lockPending(tx, id);
      if (!row) throw notFound();
      const proposal = await this.proposalOf(tx, row.id);
      return {
        ...(await this.forStaff(tx, row, proposal)),
        mobile: row.mobile,
        proposalDetail: proposal
          ? { ...proposalView(proposal), reason: proposal.reason, evidence: proposal.evidence }
          : null,
      };
    });
    await this.audit.recordView(actor, 'person_mobile', view.id);
    return view;
  }

  /**
   * The first of the two staff: proposes approving, with the evidence seen. Not who added the
   * mobile; one proposal per mobile (a second is refused, the unique index too).
   */
  async proposeAsStaff(
    actor: Actor,
    access: EffectiveAccess,
    id: string,
    input: { reason: string; evidence: string },
    now = new Date(),
  ): Promise<{ id: string; proposedBy: string }> {
    requirePermission(access, 'lead.approve_person_mobile');
    await assertFreshMfa(this.config, actor, now);
    if (!UUID.test(id)) throw notFound();
    const proposedBy = actor.accountId;
    if (proposedBy === null) throw new ForbiddenException({ error: 'staff_only' });
    // ADR-052: letting a number into a person is identity; signed with an SMS code.
    await this.stepUp.assert(actor, { type: 'lead_mobile', id, amountRial: null, step: 'request' });
    return this.db.transaction(async (tx) => {
      const row = await PersonMobiles.lockPending(tx, id);
      if (!row) throw notFound();
      if (row.addedBy !== null && row.addedBy === proposedBy) {
        throw new ForbiddenException({ error: 'added_by_same_account' });
      }
      if (await this.proposalOf(tx, row.id)) {
        throw new ConflictException({ error: 'person_mobile_already_proposed' });
      }
      await tx.insert(personMobileProposals).values({
        personMobileId: row.id,
        proposedBy,
        reason: input.reason,
        evidence: input.evidence,
      });
      await this.audit.record(
        {
          actor,
          action: 'lead.person_mobile_proposed',
          entityType: 'person',
          entityId: row.personId,
          before: { personMobileId: row.id, status: 'pending' },
          after: { personMobileId: row.id, mobileLast4: lastFour(row.mobile), proposed: true },
          reason: input.reason,
        },
        tx,
      );
      return { id: row.id, proposedBy };
    });
  }

  async decideAsStaff(
    actor: Actor,
    access: EffectiveAccess,
    id: string,
    decision: Decision,
    input: { reason: string },
    now = new Date(),
  ): Promise<{ id: string; decision: Decision }> {
    requirePermission(access, 'lead.approve_person_mobile');
    await assertFreshMfa(this.config, actor, now);
    if (!UUID.test(id)) throw notFound();
    if (decision === 'approved') {
      await this.stepUp.assert(actor, {
        type: 'lead_mobile',
        id,
        amountRial: null,
        step: 'approve',
      });
    }
    return this.db.transaction(async (tx) => {
      const row = await PersonMobiles.lockPending(tx, id);
      if (!row) throw notFound();
      // Four eyes: who added a mobile does not let it in.
      if (row.addedBy !== null && row.addedBy === actor.accountId) {
        throw new ForbiddenException({ error: 'added_by_same_account' });
      }
      if (decision === 'rejected') {
        await this.apply(tx, actor, row, decision, 'staff', input.reason, null, now);
        return { id: row.id, decision };
      }
      // Two people (owner 1405/07/23): a proposal first, and its proposer does not approve it.
      // A trigger of migration 0085 refuses the same in the database.
      const proposal = await this.proposalOf(tx, row.id);
      if (!proposal) throw new ConflictException({ error: 'person_mobile_not_proposed' });
      if (proposal.proposedBy === actor.accountId) {
        throw new ForbiddenException({ error: 'proposed_by_same_account' });
      }
      await this.apply(
        tx,
        actor,
        row,
        decision,
        'staff',
        input.reason,
        proposal.evidence,
        now,
        proposal.id,
      );
      return { id: row.id, decision };
    });
  }

  // --- the deadline --------------------------------------------------------------------------

  /** Pending mobiles past their deadline are refused, told and recorded (worker, every 15 min). */
  async expireOverdue(now = new Date()): Promise<{ rejected: number }> {
    let rejected = 0;
    for (;;) {
      const done = await this.db.transaction(async (tx) => {
        const rows = await PersonMobiles.lockOverdue(tx, now, EXPIRY_BATCH);
        for (const row of rows) {
          await this.apply(tx, EXPIRY_ACTOR, row, 'rejected', 'expiry', EXPIRY_REASON, null, now);
        }
        return rows.length;
      });
      rejected += done;
      if (done < EXPIRY_BATCH) return { rejected };
    }
  }

  // --- an import cancelled -------------------------------------------------------------------

  /** In the cancel's transaction: the batch's pending mobiles are refused, each recorded. */
  async rejectForImport(
    tx: Tx,
    actor: Actor,
    batchId: string,
    reason: string,
    now = new Date(),
  ): Promise<{ rejected: number }> {
    const rows = await PersonMobiles.lockPendingOfBatch(tx, batchId);
    for (const row of rows) {
      await this.apply(tx, actor, row, 'rejected', 'import_cancelled', reason, null, now);
    }
    return { rejected: rows.length };
  }

  // --- helpers -------------------------------------------------------------------------------

  private async apply(
    tx: Tx,
    actor: Actor,
    row: PersonMobileRow,
    decision: Decision,
    method: Method,
    reason: string,
    evidence: string | null,
    now: Date,
    proposalId: string | null = null,
  ): Promise<void> {
    if (decision === 'approved') await PersonMobiles.approve(tx, row.id);
    else await PersonMobiles.reject(tx, row.id, now);
    await tx.insert(personMobileDecisions).values({
      personMobileId: row.id,
      decision,
      method,
      decidedBy: actor.accountId,
      reason,
      evidence,
      proposalId,
    });
    await this.audit.record(
      {
        actor,
        action:
          decision === 'approved' ? 'lead.person_mobile_approved' : 'lead.person_mobile_rejected',
        entityType: 'person',
        entityId: row.personId,
        before: { personMobileId: row.id, status: 'pending' },
        after: {
          personMobileId: row.id,
          mobileLast4: lastFour(row.mobile),
          status: decision === 'approved' ? 'active' : 'rejected',
          method,
          ...(proposalId ? { proposalId } : {}),
        },
        reason,
      },
      tx,
    );
    await this.persons.tellProved(tx, actor, decision, row, row.personId);
  }

  /** One pending mobile as the staff queue shows it: the last four digits only. */
  private async forStaff(
    ex: Tx | Database,
    m: PersonMobileRow,
    known?: ProposalRow | null,
  ): Promise<PendingForStaff> {
    const ids = await this.persons.mergedIds(ex, (await this.persons.canonical(ex, m.personId)).id);
    const proposal = known === undefined ? await this.proposalOf(ex, m.id) : known;
    return {
      id: m.id,
      personId: m.personId,
      mobileLast4: lastFour(m.mobile),
      addedVia: m.addedVia,
      addedBy: m.addedBy,
      addedAt: m.createdAt.toISOString(),
      expiresAt: m.pendingExpiresAt?.toISOString() ?? null,
      hasProvedMobile: (await PersonMobiles.provedOf(ex, ids)).length > 0,
      proposal: proposal ? proposalView(proposal) : null,
    };
  }

  private async proposalOf(ex: Tx | Database, personMobileId: string): Promise<ProposalRow | null> {
    const [row] = await ex
      .select()
      .from(personMobileProposals)
      .where(eq(personMobileProposals.personMobileId, personMobileId));
    return row ?? null;
  }

  /**
   * Who this patient account is to the pending mobiles: its own mobile pending, a proved
   * approved mobile of a Person (and everyone merged with them), or neither.
   */
  private async ownerOf(
    ex: Tx | Database,
    accountId: string,
  ): Promise<{ kind: 'pending' } | { kind: 'none' } | { kind: 'proved'; personIds: string[] }> {
    const account = await this.accounts.find(accountId);
    if (!account || account.kind !== 'patient') {
      throw new ForbiddenException({ error: 'patients_only' });
    }
    if (account.mobile === null) return { kind: 'none' };
    const held = await PersonMobiles.holder(ex, account.mobile);
    if (held?.status === 'pending') return { kind: 'pending' };
    // Owner 1405/07/19: only a mobile that is active, proved (a real OTP login) and live
    // decides; never one staff entered and nobody logged in with, nor a pending one whose
    // proof a merge carried over (refused just above).
    if (
      !held ||
      held.status !== 'active' ||
      held.provedAt === null ||
      held.deletedAt !== null ||
      account.personId === null
    ) {
      return { kind: 'none' };
    }
    const person = await this.persons.canonical(ex, held.personId);
    return { kind: 'proved', personIds: await this.persons.mergedIds(ex, person.id) };
  }
}

const OWNER_REASON: Readonly<Record<Decision, string>> = {
  approved: 'تأیید صاحب موبایل تأییدشده همان شخص در پنل خودش',
  rejected: 'رد صاحب موبایل تأییدشده همان شخص در پنل خودش',
};
const EXPIRY_REASON = 'مهلت تأیید گذشت؛ خودکار رد شد';

const proposalView = (p: ProposalRow): ProposalForStaff => ({
  proposedBy: p.proposedBy,
  proposedAt: p.createdAt.toISOString(),
});

const notFound = () => new NotFoundException({ error: 'person_mobile_not_found' });
