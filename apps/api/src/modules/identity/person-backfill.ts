import { Inject, Injectable, Optional } from '@nestjs/common';
import { normalizeMobile, PERSON_DIRECTORY, type PersonDirectory } from '@sepehr/contracts';
import { and, eq, inArray, isNull } from 'drizzle-orm';
import { CLI_ACTOR } from '../../common/auth/actor';
import { AUDIT_LOG, type AuditLog } from '../../common/audit/audit.port';
import { DATABASE, type Database } from '../../db/database.module';
import { personBackfillRuns, userAccounts } from './identity.schema';

export interface ManualReviewItem {
  readonly accountId: string;
  readonly reason: 'invalid_mobile' | 'shared_mobile';
}

export interface BackfillReport {
  readonly runId: string;
  readonly mode: 'dry_run' | 'apply';
  /** Patient accounts without a person at the start. */
  readonly candidates: number;
  /** Linked (apply), or that would be (dry run). */
  readonly filled: number;
  /** Left alone, for a person to decide: never merged automatically. */
  readonly manualReview: readonly ManualReviewItem[];
}

const BATCH = 100;

export const BACKFILL_USAGE = 'usage: pnpm lead:backfill-persons [-- --dry-run | -- --apply]';

/**
 * The command line of `lead:backfill-persons`: a dry run unless `--apply` is given. A lone
 * `--` is skipped (pnpm passes the one in `pnpm lead:backfill-persons -- --apply` through);
 * anything else unknown, or both modes at once, is refused.
 */
export function parseBackfillArgs(args: readonly string[]): 'dry_run' | 'apply' {
  const given = args.filter((a) => a !== '--');
  const unknown = given.filter((a) => a !== '--apply' && a !== '--dry-run');
  if (unknown.length > 0 || (given.includes('--apply') && given.includes('--dry-run'))) {
    throw new Error(BACKFILL_USAGE);
  }
  return given.includes('--apply') ? 'apply' : 'dry_run';
}

export interface PatientRow {
  readonly id: string;
  readonly mobile: string | null;
  readonly personId: string | null;
}

/**
 * Which accounts without a person can be linked, and which need a person to decide. The
 * database already keeps patient mobiles normalized and unique (user_accounts checks), so
 * with today's data the review list stays empty; the checks guard against anything that
 * gets past them, and never merge by themselves.
 */
export function planBackfill(patients: readonly PatientRow[]) {
  const byMobile = new Map<string, string[]>();
  for (const p of patients) {
    const mobile = p.mobile === null ? null : normalizeMobile(p.mobile);
    if (mobile !== null) byMobile.set(mobile, [...(byMobile.get(mobile) ?? []), p.id]);
  }
  const candidates = patients.filter((p) => p.personId === null);
  const manualReview: ManualReviewItem[] = [];
  const fillable: { id: string; mobile: string }[] = [];
  for (const c of candidates) {
    const mobile = c.mobile === null ? null : normalizeMobile(c.mobile);
    if (mobile === null) manualReview.push({ accountId: c.id, reason: 'invalid_mobile' });
    else if ((byMobile.get(mobile)?.length ?? 0) > 1) {
      manualReview.push({ accountId: c.id, reason: 'shared_mobile' });
    } else fillable.push({ id: c.id, mobile });
  }
  return { candidates, fillable, manualReview };
}

/**
 * Links the patient accounts made before the lead module to their Person (task 2-5b
 * decision 1), through the lead module's PERSON_DIRECTORY and never its tables. Not a SQL
 * migration: the audit trail's hash chain is computed in the application, so only the
 * application can record each link.
 *
 * - A dry run changes nothing and reports what an apply would do; an apply needs asking.
 * - Idempotent: only accounts still without a person are touched, and finding a person by
 *   mobile never makes a second one, so running it again adds nothing.
 * - In batches, each batch's links and their audit rows in one transaction.
 * - An account whose mobile does not normalize, or shares its normalized mobile with
 *   another patient account, is left for manual review and never merged automatically.
 * - Every run, dry or not, is recorded in person_backfill_runs.
 */
@Injectable()
export class PersonBackfill {
  constructor(
    @Inject(DATABASE) private readonly db: Database,
    @Inject(AUDIT_LOG) private readonly audit: AuditLog,
    @Optional() @Inject(PERSON_DIRECTORY) private readonly persons: PersonDirectory | null,
  ) {}

  async run(mode: 'dry_run' | 'apply'): Promise<BackfillReport> {
    if (mode === 'apply' && !this.persons) throw new Error('PERSON_DIRECTORY is not provided');
    const startedAt = new Date();
    const patients = await this.db
      .select({ id: userAccounts.id, mobile: userAccounts.mobile, personId: userAccounts.personId })
      .from(userAccounts)
      .where(and(eq(userAccounts.kind, 'patient'), isNull(userAccounts.deletedAt)));

    const { candidates, fillable, manualReview } = planBackfill(patients);

    let filled = mode === 'dry_run' ? fillable.length : 0;
    if (mode === 'apply' && this.persons) {
      const persons = this.persons;
      for (let i = 0; i < fillable.length; i += BATCH) {
        const batch = fillable.slice(i, i + BATCH);
        // Found or created first, each in the lead module's own transaction (idempotent).
        const found = new Map<string, string>();
        for (const account of batch) {
          // A pending mobile (task 9-3) is linked at its first login after approval.
          const { personId } = await persons.findOrCreateByMobile(account.mobile);
          if (personId !== null) found.set(account.id, personId);
        }
        filled += await this.db.transaction(async (tx) => {
          let linked = 0;
          const rows = await tx
            .select({ id: userAccounts.id })
            .from(userAccounts)
            .where(
              and(
                inArray(
                  userAccounts.id,
                  batch.map((b) => b.id),
                ),
                isNull(userAccounts.personId),
              ),
            )
            .for('update');
          for (const { id } of rows) {
            const personId = found.get(id);
            if (!personId) continue;
            await tx.update(userAccounts).set({ personId }).where(eq(userAccounts.id, id));
            await this.audit.record(
              {
                actor: CLI_ACTOR,
                action: 'identity.person_linked',
                entityType: 'user_account',
                entityId: id,
                before: { personId: null },
                after: { personId },
                reason: 'backfill: lead:backfill-persons',
              },
              tx,
            );
            linked++;
          }
          return linked;
        });
      }
    }

    const [run] = await this.db
      .insert(personBackfillRuns)
      .values({
        mode,
        candidates: candidates.length,
        filled,
        manualReview,
        startedAt,
        finishedAt: new Date(),
      })
      .returning({ id: personBackfillRuns.id });
    if (!run) throw new Error('backfill run insert returned nothing');
    return { runId: run.id, mode, candidates: candidates.length, filled, manualReview };
  }
}
