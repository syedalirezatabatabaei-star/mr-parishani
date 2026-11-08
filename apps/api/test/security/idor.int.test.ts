import { randomUUID } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { CLI_ACTOR } from '../../src/common/auth/actor';
import { SERVICE_SMS_SENDER } from '../../src/modules/service/service-authorization.service';
import { SettlementService } from '../../src/modules/settlement/settlement.service';
import {
  call,
  CapturingTextSender,
  createNode,
  grantRole,
  loggedInAccount,
  startHarness,
  type Harness,
} from '../identity/harness';
import { fundingSteps } from '../credit/funding-steps';
import { CREDIT_HARNESS, creditWorld, type Body, type Row } from '../credit/world';

/**
 * Task 9-3 (R3; doc 19: «مجموعه آزمون IDOR برای همه ماژول‌ها، یک آزمون به‌ازای هر endpoint
 * دارای شناسه»): every operation of the OpenAPI document whose path takes an identifier, called
 * with a real identifier of someone else's record (a whole loan's world: its patient, its
 * doctor, its center, in Tehran) by five who own none of it: another patient, another center's
 * manager, a signed-in staff member with no role, a network specialist of another city (scope)
 * and an advisor (their own cases only). None may succeed (2xx), except what is
 * public by design (listed below with why). A mutation refused for its empty body (400) never
 * reached the record, which is no less a refusal; how many were is reported, so the reading is
 * honest: those owners' checks are proven by each module's own tests.
 */

type Attacker = 'patient' | 'center' | 'staff' | 'specialist' | 'advisor';
const ATTACKERS: readonly Attacker[] = ['patient', 'center', 'staff', 'specialist', 'advisor'];

/** Open to anyone by design: the public pages and booking's free times (ADR-027). */
const PUBLIC_BY_DESIGN: Readonly<Record<string, string>> = {
  'GET /public/doctors/{slug}': 'a published profile is public',
  'GET /public/workplaces/{id}': 'a listed workplace is public (booking page)',
  'GET /booking/workplaces/{id}/free-slots': 'free times are shown to every signed-in patient',
  'GET /catalog/workplaces/{id}/quote': 'a listed workplace’s prices are public',
};

const OPENAPI = join(__dirname, '../../../../packages/api-client/openapi.json');

let h: Harness;
let w: Awaited<ReturnType<typeof creditWorld>>;
const tokens: Record<Attacker, string> = {
  patient: '',
  center: '',
  staff: '',
  specialist: '',
  advisor: '',
};
const texts = new CapturingTextSender();

/** One real identifier of the world's records, by the table a path names it from. */
const ids = new Map<string, string>();
async function first(sqlText: string): Promise<string | undefined> {
  const { rows } = await h.owner.query<Row>(sqlText);
  const v = rows[0]?.['id'];
  return typeof v === 'string' ? v : undefined;
}

/** Which record a path's parameter is, by the path and the parameter's name. */
const SOURCES: readonly [RegExp, string, string][] = [
  [/\/me\/tickets\/|\/panel\/tickets\/|^\/tickets\//, 'id', 'SELECT id FROM tickets'],
  [/\/panel\/complaints\//, 'id', "SELECT id FROM tickets WHERE kind = 'complaint'"],
  [/tickets\/\{id\}\/attachments/, 'attachmentId', 'SELECT id FROM ticket_attachments'],
  [/tickets\/\{id\}\/messages/, 'messageId', 'SELECT id FROM ticket_messages'],
  [/appointments\//, 'id', 'SELECT id FROM appointments'],
  [
    /\/booking\/workplaces\/|\/catalog\/workplaces\/|\/public\/workplaces\/|\/proformas\/workplaces\//,
    'id',
    'SELECT id FROM doctor_workplaces',
  ],
  [/\/booking\/exceptions\//, 'id', 'SELECT id FROM availability_exceptions'],
  [/\/booking\/advisor\/cases\/|\/lead\/cases\//, 'id', 'SELECT id FROM cases'],
  [/\/credit\/cases\//, 'caseId', 'SELECT id FROM cases'],
  [/\/catalog\/centers\//, 'id', 'SELECT id FROM centers'],
  [/\/catalog\/branches\//, 'id', 'SELECT id FROM branches'],
  [/\/catalog\/doctors\//, 'id', 'SELECT id FROM doctors'],
  [/\/catalog\/media\//, 'id', 'SELECT id FROM media_assets'],
  [/\/catalog\/tariffs\/|\/catalog\/network\/tariffs\//, 'id', 'SELECT id FROM tariffs'],
  [/tariff-versions\//, 'id', 'SELECT id FROM tariff_versions'],
  [/\/catalog\/profile-versions\//, 'id', 'SELECT id FROM doctor_profile_versions'],
  [/\/catalog\/requests\//, 'id', 'SELECT id FROM center_change_requests'],
  [/\/catalog\/secretaries\//, 'id', 'SELECT id FROM user_accounts'],
  [/\/catalog\/imports\//, 'id', 'SELECT id FROM catalog_import_batches'],
  [/\/lead\/imports\//, 'id', 'SELECT id FROM lead_import_batches'],
  [/\/lead\/persons\/|\/lead\/person-merges\//, 'id', 'SELECT id FROM persons'],
  [/proformas\//, 'id', 'SELECT id FROM proformas'],
  [/credit-applications\/|\/credit\/applications\//, 'id', 'SELECT id FROM credit_applications'],
  [/documents\/\{documentId\}/, 'documentId', 'SELECT id FROM credit_documents'],
  [/decisions\/\{decisionId\}/, 'decisionId', 'SELECT id FROM credit_decisions'],
  [
    /\/credit\/groups\//,
    'id',
    'SELECT case_group_id AS id FROM credit_applications WHERE case_group_id IS NOT NULL',
  ],
  [/\/credit\/cancellations\//, 'id', 'SELECT id FROM credit_application_cancellations'],
  [/penalty-overrides\//, 'id', 'SELECT id FROM credit_penalty_overrides'],
  [/\{applicationId\}/, 'applicationId', 'SELECT id FROM credit_applications'],
  [/contracts\//, 'id', 'SELECT id FROM contracts'],
  [/deliveries\//, 'id', 'SELECT id FROM physical_deliveries'],
  [/deliveries\/\{id\}\/items/, 'itemId', 'SELECT id FROM physical_delivery_items'],
  [/\/receipts\//, 'id', 'SELECT id FROM completion_receipts'],
  [/\/funding\/requests\//, 'id', 'SELECT id FROM funding_requests'],
  [/\/wallet\/purses\/|\/service\/patients\//, 'id', 'SELECT id FROM credit_purses'],
  [/\/service\/patients\//, 'purseId', 'SELECT id FROM credit_purses'],
  [/\/wallet\/special-operations\//, 'id', 'SELECT id FROM purse_operation_requests'],
  [/credit-transfers\//, 'id', 'SELECT id FROM credit_transfers'],
  [/\/service\/authorizations\//, 'id', 'SELECT id FROM service_authorizations'],
  [
    /\/settlement\/statements\/|\/settlement\/panel\/statements\//,
    'id',
    'SELECT id FROM settlement_statements',
  ],
  [/\/settlement\/disputes\//, 'id', 'SELECT id FROM financial_disputes'],
  [/\/settlement\/cash-services\//, 'id', 'SELECT id FROM cash_services'],
  [/\/settlement\/payouts\//, 'id', 'SELECT id FROM payout_orders'],
  [
    /\/repayment\/schedules\/|\/me\/repayment\/schedules\//,
    'id',
    'SELECT id FROM installment_schedules',
  ],
  [/\/repayment\/payments\//, 'id', 'SELECT id FROM payments'],
  [/\/repayment\/bank-statements\//, 'id', 'SELECT id FROM bank_statement_imports'],
  [/\/refund-payments\//, 'id', 'SELECT id FROM refund_payments'],
  [/\/collection\/items\//, 'id', 'SELECT id FROM collection_items'],
  [/\/collection\/tasks\//, 'id', 'SELECT id FROM collection_tasks'],
  [/\/collection\/promises\//, 'id', 'SELECT id FROM payment_promises'],
  [/\/collection\/borrower-status\//, 'id', 'SELECT id FROM borrower_status_events'],
  [/\/instruments\/|\/instrument-releases\//, 'id', 'SELECT id FROM instruments'],
  [/\/instrument-releases\//, 'instrumentId', 'SELECT id FROM instruments'],
  [/\/instrument-executions\//, 'id', 'SELECT id FROM instrument_executions'],
  [/\/notification\/campaigns\//, 'id', 'SELECT id FROM sms_campaigns'],
  [/\/notification\/scheduled-sms\//, 'id', 'SELECT id FROM sms_dispatches'],
  [/\/reporting\/exports\//, 'id', 'SELECT id FROM report_exports'],
  [/\/reporting\/filters\//, 'id', 'SELECT id FROM report_saved_filters'],
  [/\/ledger\/accounts\//, 'id', 'SELECT id FROM ledger_accounts'],
  [/\/ledger\/journals\//, 'id', 'SELECT id FROM journal_entries'],
  [/\/me\/guarantees\//, 'id', 'SELECT id FROM credit_guarantors'],
  [/\/auth\/sessions\//, 'id', 'SELECT id FROM sessions'],
  [/\/access\/assignments\//, 'id', 'SELECT id FROM role_assignments'],
  [/\/access\/org-nodes\//, 'id', 'SELECT id FROM org_nodes'],
  [/\/access\/roles\//, 'id', 'SELECT id FROM roles'],
  [/\/access\/accounts\/|\/lead\/agents\//, 'accountId', 'SELECT id FROM user_accounts'],
  [/\/config\/proposals\//, 'id', 'SELECT id FROM config_values'],
  [/\/calendar\/holidays\//, 'id', 'SELECT id FROM holidays'],
  [/\/identity\/totp-resets\//, 'id', 'SELECT id FROM totp_reset_requests'],
  [/\/me\/credit-transfers\/\{applicationId\}\/\{id\}/, 'id', 'SELECT id FROM credit_transfers'],
  [/\/settlement\/payouts\/exports\//, 'batchId', 'SELECT id FROM payout_orders'],
];

/** Parameters that are codes, not someone's record: a known value, no owner to cross. */
const CODES: Readonly<Record<string, string>> = {
  slug: '',
  code: 'general',
  key: 'identity.session',
  unit: 'support',
  index: '0',
};

interface Operation {
  readonly method: string;
  readonly path: string;
}

function operations(): Operation[] {
  const doc = JSON.parse(readFileSync(OPENAPI, 'utf8')) as {
    paths: Record<string, Record<string, unknown>>;
  };
  const out: Operation[] = [];
  for (const [full, ops] of Object.entries(doc.paths)) {
    if (!full.includes('{')) continue;
    for (const m of Object.keys(ops)) {
      if (['get', 'post', 'put', 'patch', 'delete'].includes(m)) {
        out.push({ method: m.toUpperCase(), path: full.replace('/api/v1', '') });
      }
    }
  }
  return out.sort((a, b) => `${a.path} ${a.method}`.localeCompare(`${b.path} ${b.method}`));
}

const OPERATIONS = operations();
const results: Record<string, Record<Attacker, number>> = {};
const fromFixture = new Set<string>();

/** The path with each parameter a real identifier of the world (or a code, or a random id). */
function filled(op: Operation): string {
  return op.path.replace(/\{(\w+)\}/g, (_, name: string) => {
    if (name in CODES) {
      return name === 'slug' ? (ids.get('slug') ?? 'no-such') : (CODES[name] ?? '');
    }
    for (const [pattern, param, query] of SOURCES) {
      if (param === name && pattern.test(op.path)) {
        const id = ids.get(query);
        if (id) {
          fromFixture.add(`${op.method} ${op.path}`);
          return id;
        }
      }
    }
    return randomUUID();
  });
}

beforeAll(async () => {
  h = await startHarness({ ...CREDIT_HARNESS, overrides: [[SERVICE_SMS_SENDER, texts]] });
  w = await creditWorld(h);
  // A whole loan, owned by the world: decided, funded, a service final, its payable, a ticket.
  const steps = fundingSteps(h, w, {
    manager: await w.role('credit_manager'),
    finance: await w.role('accounting'),
  });
  const { patient, applicationId } = await steps.approved();
  await steps.complete(patient, applicationId);
  const purseId = await steps.fund(applicationId);
  const lines = (await w.staff(w.doctor, 'GET', `/service/patients/${purseId}/lines`)).body[
    'lines'
  ] as Body[];
  const made = await w.staff(w.doctor, 'POST', '/service/authorizations', {
    purseId,
    proformaLineIds: [lines[0]?.['id']],
  });
  const code = /(\d{6})\s*$/.exec(
    [...texts.sent].reverse().find((t) => t.mobile === patient.mobile)?.text ?? '',
  )?.[1];
  await w.staff(w.doctor, 'POST', `/service/authorizations/${made.body['id'] as string}/deliver`, {
    code,
  });
  await h.app.get(SettlementService).accrue(CLI_ACTOR, made.body['id'] as string);
  await h.owner.query(
    `INSERT INTO config_values (key, scope_level, value, effective_at, status, reason, decided_at)
     VALUES ('ticket.topics', 'global', $1::jsonb, now(), 'approved', 'آزمون', now())`,
    [
      JSON.stringify([
        { code: 'general', title: 'عمومی', unit: 'support', responseHours: 0, active: true },
      ]),
    ],
  );
  await w.as(patient, 'POST', '/me/tickets', {
    topicCode: 'general',
    subject: 'پرسش',
    body: 'پرسشی دارم.',
    links: [],
  });

  for (const [, , query] of SOURCES) {
    if (!ids.has(query)) {
      const id = await first(query);
      if (id) ids.set(query, id);
    }
  }
  const slug = await first('SELECT slug AS id FROM doctor_profiles');
  if (slug) ids.set('slug', slug);

  // The three who own none of it.
  tokens.patient = (await w.patient()).token;
  const center = await loggedInAccount(h, 'center');
  await grantRole(h, center.id, 'center_manager', {
    kind: 'center',
    nodeId: await createNode(h, 'center'),
  });
  tokens.center = center.access;
  tokens.staff = (await loggedInAccount(h, 'staff')).access;
  const specialist = await loggedInAccount(h, 'staff');
  await grantRole(h, specialist.id, 'network_specialist', { kind: 'city', code: 'shiraz' });
  tokens.specialist = specialist.access;
  const advisor = await loggedInAccount(h, 'staff');
  await grantRole(h, advisor.id, 'advisor', { kind: 'own' });
  tokens.advisor = advisor.access;
}, 900_000);

afterAll(async () => {
  // The coverage, for docs/security (task 9-3): each operation's answers and whether its
  // identifier was a real record of the world.
  writeFileSync(
    join(__dirname, '../../../../.turbo/idor-coverage.json'),
    JSON.stringify(
      { results, fromFixture: [...fromFixture].sort(), operations: OPERATIONS.length },
      null,
      2,
    ),
  );
  await h.close();
});

describe('task 9-3 (R3): no one reaches another’s record through an identifier', () => {
  it.each(OPERATIONS.map((op) => [`${op.method} ${op.path}`, op] as const))(
    '%s',
    async (name, op) => {
      const path = filled(op);
      const answers = {} as Record<Attacker, number>;
      for (const who of ATTACKERS) {
        const res = await call(h, op.method, path, {
          bearer: tokens[who],
          ...(op.method === 'GET' || op.method === 'DELETE' ? {} : { body: {} }),
        });
        answers[who] = res.status;
      }
      results[name] = answers;
      if (name in PUBLIC_BY_DESIGN) return;
      for (const who of ATTACKERS) {
        expect(
          answers[who] >= 200 && answers[who] < 300,
          `${name} as ${who}: ${String(answers[who])}`,
        ).toBe(false);
      }
    },
  );
});
