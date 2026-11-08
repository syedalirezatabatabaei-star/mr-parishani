import { ForbiddenException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import type { CreditCaseStatus } from '@sepehr/contracts';
import { desc, eq } from 'drizzle-orm';
import type { EffectiveAccess } from '../../common/auth/access.port';
import {
  WORKPLACE_DIRECTORY,
  type WorkplaceDirectory,
} from '../../common/catalog/workplace-directory.port';
import { LEAD_CASES, type LeadCases } from '../../common/lead/lead-cases.port';
import {
  PROFORMA_DIRECTORY,
  type ProformaDirectory,
} from '../../common/proforma/proforma-directory.port';
import { DATABASE, type Database } from '../../db/database.module';
import { creditApplications } from './credit.schema';

type ApplicationRow = typeof creditApplications.$inferSelect;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const within = (path: string, by: string) => path === by || path.startsWith(`${by}.`);
const notFound = () => new NotFoundException({ error: 'case_not_found' });

/**
 * What an advisor, a doctor or a center sees of a case's credit (task 3-6; doc 10 §6,
 * doc 04 §4): «in review / approved / rejected», and for the case's own advisor the next
 * step. Never a score, an amount, a condition or a reason, so nothing here needs the
 * output filter; the shape itself has no room for them (doc 10 §10 test 11).
 *
 * The advisor reaches the cases assigned to them; a doctor or center the cases whose
 * proforma is at a workplace their scope covers (rule 13). Anyone else: no such case.
 */
@Injectable()
export class CreditStatusService {
  constructor(
    @Inject(DATABASE) private readonly db: Database,
    @Inject(LEAD_CASES) private readonly leads: LeadCases,
    @Inject(PROFORMA_DIRECTORY) private readonly proformas: ProformaDirectory,
    @Inject(WORKPLACE_DIRECTORY) private readonly workplaces: WorkplaceDirectory,
  ) {}

  async ofCase(access: EffectiveAccess, caseId: string): Promise<CreditCaseStatus> {
    if (!access.permissions.has('credit.read_status')) {
      throw new ForbiddenException({ error: 'permission_required' });
    }
    if (!UUID.test(caseId)) throw notFound();
    const rows = await this.db
      .select()
      .from(creditApplications)
      .where(eq(creditApplications.caseId, caseId))
      .orderBy(desc(creditApplications.createdAt));
    const advisor = (await this.leads.assigneeOf(caseId)) === access.accountId;
    if (!advisor && !(await this.coversAny(access, rows))) throw notFound();

    // The latest application that still counts; an expired one leaves the case without.
    const app = rows.find((r) => r.status !== 'expired') ?? null;
    const { state, next } = summary(app);
    return { caseId, state, nextAction: advisor ? next : null };
  }

  private async coversAny(access: EffectiveAccess, rows: readonly ApplicationRow[]) {
    for (const proformaId of new Set(rows.map((r) => r.proformaId))) {
      const proforma = await this.proformas.proforma(proformaId);
      if (!proforma) continue;
      const workplace = await this.workplaces.workplace(proforma.workplaceId);
      if (!workplace) continue;
      const covered = access.scopes.some((scope) => {
        if (scope.kind === 'global') return true;
        if (scope.kind === 'city') return scope.code === workplace.cityCode;
        if (scope.kind === 'center' || scope.kind === 'branch' || scope.kind === 'doctor') {
          return within(workplace.nodePath, scope.path);
        }
        return false;
      });
      if (covered) return true;
    }
    return false;
  }
}

function summary(app: ApplicationRow | null): {
  state: CreditCaseStatus['state'];
  next: CreditCaseStatus['nextAction'];
} {
  if (app === null) return { state: 'none', next: 'choose_plan' };
  switch (app.status) {
    case 'draft':
      return { state: 'in_review', next: 'submit' };
    case 'incomplete':
      return {
        state: 'in_review',
        next: app.needsMoreGuarantors ? 'add_guarantor' : 'complete_documents',
      };
    case 'approved':
      return { state: 'approved', next: 'none' };
    case 'conditional':
      return { state: 'approved', next: 'meet_conditions' };
    case 'rejected':
      return { state: 'rejected', next: 'none' };
    default:
      return { state: 'in_review', next: 'wait_for_review' };
  }
}
