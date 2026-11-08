import { createHash, randomUUID } from 'node:crypto';
import { normalizeDigits } from '@sepehr/contracts';
import type { ContractTemplate } from '@sepehr/contracts';
import { ContractTemplateGuard } from '../../src/modules/contract/contract-template.guard';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { CONFIG } from '../../src/common/config/config.port';
import { OUTBOX } from '../../src/common/events/outbox.port';
import { OBJECT_STORAGE, type ObjectStorage } from '../../src/common/storage/object-storage.port';
import { DATABASE, type Database } from '../../src/db/database.module';
import { ChromiumPdfRenderer } from '../../src/infra/pdf-renderer';
import { contractHtml } from '../../src/modules/contract/contract-html';
import { ContractPrinter } from '../../src/modules/contract/contract-printer';
import { newMobile, startHarness, type Harness, type loggedInAccount } from '../identity/harness';
import { CREDIT_HARNESS, creditWorld, type Body, type Patient, type Row } from '../credit/world';

/**
 * Task 4-1 (doc 12 §2): a template is never published without the cancellation penalty
 * (§9 test 15); a contract is numbered per lender and Jalali year, filled once, printed
 * once to a PDF whose hash never changes, even when the template changes after (doc 13
 * 4-1 acceptance); the borrower and each guarantor accept it themselves with a code.
 */

let h: Harness;
let w: Awaited<ReturnType<typeof creditWorld>>;
type Staff = Awaited<ReturnType<typeof loggedInAccount>>;
let manager: Staff;
let strategyA: Staff;
let strategyB: Staff;

const alef = {
  job: 'official',
  employmentStartedOn: { year: 1398, month: 1, day: 1 },
  coverage: 'full',
  obligationsRial: '1000000',
  newInstallmentRial: '4000000',
};
const guarantorRaw = {
  job: 'official',
  employmentStartedOn: { year: 1395, month: 1, day: 1 },
  averageBalanceRial: '30000000',
  installmentRial: '900000',
  debts: 'none_or_very_low',
  independence: 'fully_independent',
};
/** The smallest file whose bytes say PDF: what the fake renderer prints. */
const FAKE_PDF = Buffer.from('%PDF-1.4\n% e2e contract\n%%EOF\n');

beforeAll(async () => {
  h = await startHarness(CREDIT_HARNESS);
  w = await creditWorld(h);
  manager = await w.role('credit_manager');
  strategyA = await w.role('strategy_manager');
  strategyB = await w.role('strategy_manager');
}, 180_000);

afterAll(async () => {
  await h.close();
});

/** An approved application; with a guarantor (consented, documented, scored) if asked. */
async function approved(withGuarantor: boolean, visitRial?: string) {
  const { patient, applicationId } = await w.inReview(undefined, undefined, visitRial);
  await w.staff(w.creditSpecialist, 'POST', `/credit/applications/${applicationId}/score-sheets`, {
    subject: 'borrower',
    raw: alef,
  });
  let guarantor: Patient | null = null;
  if (withGuarantor) {
    const mobile = newMobile();
    await w.as(patient, 'POST', `/me/credit-applications/${applicationId}/guarantors`, {
      mobile: `0${mobile}`,
    });
    guarantor = await w.patient(mobile);
    await w.consent(guarantor, applicationId, 'guarantor');
    await w.documented(guarantor, applicationId, 'guarantor');
    const scoring = await w.staff(
      w.creditSpecialist,
      'GET',
      `/credit/applications/${applicationId}/scoring`,
    );
    await w.staff(
      w.creditSpecialist,
      'POST',
      `/credit/applications/${applicationId}/score-sheets`,
      {
        subject: 'guarantor',
        guarantorId: (scoring.body['guarantors'] as Body[])[0]?.['id'],
        raw: guarantorRaw,
      },
    );
  }
  await w.staff(w.creditSpecialist, 'POST', `/credit/applications/${applicationId}/to-decision`);
  const proposed = await w.staff(
    w.creditSpecialist,
    'POST',
    `/credit/applications/${applicationId}/decisions`,
    { outcome: 'approved', reason: 'رتبه الف' },
  );
  const confirmed = await w.staff(
    manager,
    'POST',
    `/credit/applications/${applicationId}/decisions/${proposed.body['id'] as string}/confirm`,
  );
  expect(confirmed.status).toBe(201);
  return { patient, guarantor, applicationId };
}

function printer(render: (html: string) => Promise<Buffer>) {
  return new ContractPrinter(
    { register: () => undefined },
    h.app.get(CONFIG),
    h.app.get(OUTBOX),
    { render },
    h.app.get<ObjectStorage>(OBJECT_STORAGE),
  );
}

async function print(contract: Body, render = () => Promise.resolve(FAKE_PDF)) {
  const db = h.app.get<Database>(DATABASE);
  await db.transaction((tx) =>
    printer(render).handle(
      {
        id: randomUUID(),
        type: 'contract.requested',
        aggregateType: 'contract',
        aggregateId: contract['id'] as string,
        payload: {
          contractId: contract['id'],
          creditApplicationId: contract['creditApplicationId'],
        },
        occurredAt: new Date().toISOString(),
      },
      tx,
    ),
  );
}

async function propose(body: string) {
  return w.staff(strategyA, 'POST', '/config/proposals', {
    key: 'contract.loan_template',
    scope: { level: 'global' },
    value: {
      title: 'قرارداد وام درمان',
      sample: true,
      lender: { entityId: 'aramesh', name: 'شرکت آرامش ثروت' },
      body,
    },
    reason: 'آزمون قالب قرارداد',
  });
}

const BODY =
  '# طرفین\n\nقرارداد {{contract.number}} میان {{lender.name}} و {{borrower.name}} برای وام {{loan.amount}}.\n\n{{installments.table}}\n\nخسارت انصراف {{cancellation.penaltyPercent}} مبلغ مصوب است.';

describe('the contract template (doc 12 §9 test 15)', () => {
  it('is never proposed without the cancellation penalty, nor with an unknown field', async () => {
    const without = await propose(BODY.replace('{{cancellation.penaltyPercent}}', 'هجده درصد'));
    expect(without.status).toBe(400);
    expect(without.body['error']).toBe('contract_template_invalid');
    expect(without.body).toMatchObject({ missing: ['cancellation.penaltyPercent'], unknown: [] });
    const unknown = await propose(`${BODY}\n\nتشخیص: {{patient.diagnosis}}`);
    expect(unknown.body).toMatchObject({
      error: 'contract_template_invalid',
      unknown: ['patient.diagnosis'],
    });
    // A sound one is proposed; it applies only once a second person approves it.
    const sound = await propose(BODY);
    expect(sound.status).toBe(201);
    expect(sound.body['status']).toBe('proposed');
  });
});

describe('the drafts from the client samples (owner 1405/07/27; migration 0098)', () => {
  it('pass the template guard, stay drafts, and keep the samples word for word', async () => {
    const { rows } = await h.owner.query<{ key: string; value: Record<string, unknown> }>(
      `SELECT key, value FROM config_values WHERE reason LIKE '%مهاجرت 0098%' ORDER BY key`,
    );
    expect(rows.map((r) => r.key)).toEqual(['contract.loan_template', 'credit.consent_text']);
    const template = rows[0]?.value as unknown as ContractTemplate;
    // A draft: printed with its label, and the launch check holds a patient launch.
    expect(template.sample).toBe(true);
    expect(template.lender).toEqual({ entityId: 'aramesh', name: 'شرکت آرامش ثروت' });
    expect(h.app.get(ContractTemplateGuard, { strict: false }).check(template)).toBeNull();
    // Nothing removed or softened: the harshest clauses, as the samples word them.
    for (const clause of [
      'صندوق را ضمن عقد خارج و لازم با حق توکیل غیر و سلب حق عزل از خود و ضامنین و وکیل به صورت بلاعزل وکیل قرار می‌دهیم',
      'کلیه دیون را به دین حال تبدیل نموده و از موجودی هر یک از حساب‌های اینجانبان در صندوق برداشت نماید',
      'حق هر گونه مطالبه اسناد یا اعتراضی را از خود سلب می‌نمائیم',
      'متضامناً متعهد و ضامن پرداخت اصل و سود وام و جبران خسارات وارده می باشد',
      'بدون اعلام قبلی با اجرای ضمانتنامه‌های توثیق شده طلب خود را وصول کرده',
      'پرداخت ۱۸٪ مبلغ وام به عنوان خسارت کنسلی امتیاز وام امکان پذیر است',
      'تحت هیچ شرایطی امکان تهاتر مسدودی با اقساط وام وجود ندارد',
      'کلیه تبعات عدم اجرای تعهدات را می‌پذیریم',
    ]) {
      expect(template.body).toContain(clause);
    }
    // Three guarantors, as the form has them; the system's own fields kept.
    expect(template.body).toContain('# مشخصات ضامن ۳');
    expect(template.body).toContain('{{cancellation.penaltyPercent}}');
    expect(rows[1]?.value['text']).toMatch(/^پیش‌نویس — در انتظار تأیید حقوقی: /);
  });
});

describe('the lender of a template (ADR-007)', () => {
  it('is only an entity that may earn income: aramesh, never sepehr', async () => {
    const refused = await w.staff(strategyA, 'POST', '/config/proposals', {
      key: 'contract.loan_template',
      scope: { level: 'global' },
      value: {
        title: 'قرارداد وام درمان',
        sample: true,
        lender: { entityId: 'sepehr', name: 'سپهر سلامتی' },
        body: BODY,
      },
      reason: 'آزمون نهاد وام‌دهنده',
    });
    expect(refused.status).toBe(400);
    expect(refused.body).toMatchObject({
      error: 'lender_not_allowed',
      entityId: 'sepehr',
      allowed: ['aramesh'],
    });
  });
});

describe('a contract (doc 12 §2)', () => {
  it('is asked for an approved application only, once, numbered per lender and year', async () => {
    const { applicationId } = await approved(false);
    const { applicationId: pending } = await w.inReview();
    expect(
      (await w.staff(w.completion, 'POST', '/contracts', { creditApplicationId: pending })).body[
        'error'
      ],
    ).toBe('not_approved');
    expect(
      (await w.staff(w.doctor, 'POST', '/contracts', { creditApplicationId: applicationId }))
        .status,
    ).toBe(403);
    const made = await w.staff(w.completion, 'POST', '/contracts', {
      creditApplicationId: applicationId,
    });
    expect(made.status).toBe(201);
    expect(made.body).toMatchObject({
      status: 'generating',
      entityId: 'aramesh',
      sample: true,
      sha256: null,
      parties: [{ role: 'borrower', guarantorId: null, acceptedAt: null }],
    });
    expect(made.body['number']).toMatch(/^1[34]\d\d-\d{6}$/);
    expect(
      (await w.staff(w.completion, 'POST', '/contracts', { creditApplicationId: applicationId }))
        .body['error'],
    ).toBe('contract_exists');

    // The next one of the year takes the next number.
    const { applicationId: second } = await approved(false);
    const next = await w.staff(w.completion, 'POST', '/contracts', { creditApplicationId: second });
    const [year, n] = (made.body['number'] as string).split('-');
    expect(next.body['number']).toBe(`${year ?? ''}-${String(Number(n) + 1).padStart(6, '0')}`);

    // What it says: the approved amount in tomans, the penalty of doc 02 §6, Jalali dates.
    const { rows } = await h.owner.query<Row>('SELECT fields FROM contracts WHERE id = $1', [
      made.body['id'],
    ]);
    const fields = rows[0]?.['fields'] as Record<string, string>;
    expect(fields['loan.amount']).toBe('۹۶۰٬۰۰۰ تومان');
    expect(fields['cancellation.penaltyPercent']).toBe('۱۸٪');
    expect(fields['lender.name']).toBe('شرکت آرامش ثروت');
    const table = JSON.parse(fields['installments.table'] ?? '[]') as Body[];
    expect(table).toHaveLength(12);
    expect(table[0]?.['dueOn']).toMatch(/^[۰-۹]{4}\/[۰-۹]{2}\/[۰-۹]{2}$/);
    // No treatment detail: the services and the doctor are not in a loan contract.
    expect(JSON.stringify(fields)).not.toMatch(/جرم|ویزیت|دکتر|کلینیک/);
  });

  it('says every amount exactly: the PDF adds up to its installment table, to the rial', async () => {
    // A share that is no whole number of tomans: 6,000,007 + 2 × 3,000,000 rials. The plan
    // rounds its shares (ADR-035), so the 20% down payment is whole tomans; the loan (share
    // minus down payment) and the first installment carry the 7 rials a toman cannot hold,
    // and they are never dropped.
    const { applicationId } = await approved(false, '6000007');
    const made = await w.staff(w.completion, 'POST', '/contracts', {
      creditApplicationId: applicationId,
    });
    expect(made.status).toBe(201);
    const { rows } = await h.owner.query<Row>('SELECT fields FROM contracts WHERE id = $1', [
      made.body['id'],
    ]);
    const fields = rows[0]?.['fields'] as Record<string, string>;
    // «۲۴٬۶۹۱ تومان و ۴ ریال» → 246914n: the text read back, as a person would.
    const rials = (text: string | undefined) => {
      const m = /^([۰-۹٬]+) تومان(?: و ([۰-۹]) ریال)?$/.exec(text ?? '');
      if (!m) throw new Error(`not an exact amount: ${String(text)}`);
      const latin = (s: string) => normalizeDigits(s).replace(/٬/g, '');
      return BigInt(latin(m[1] ?? '')) * 10n + BigInt(latin(m[2] ?? '0'));
    };
    const share = 12_000_007n;
    const down = rials(fields['downPayment.amount']);
    const loan = rials(fields['loan.amount']);
    const planFee = rials(fields['planFee.amount']);
    const total = rials(fields['totalObligation.amount']);
    const table = JSON.parse(fields['installments.table'] ?? '[]') as { amount: string }[];
    expect(table).toHaveLength(12);
    const installments = table.reduce((sum, i) => sum + rials(i.amount), 0n);
    // Exactly: nothing lost between the parts and the whole.
    expect(down).toBe(2_400_000n);
    expect(down + loan).toBe(share);
    expect(loan + planFee).toBe(total);
    expect(installments).toBe(total);
    expect(fields['downPayment.amount']).toBe('۲۴۰٬۰۰۰ تومان');
    expect(fields['loan.amount']).toBe('۹۶۰٬۰۰۰ تومان و ۷ ریال');
    expect(planFee % 10n).toBe(0n);
    // The rounding is stated in the contract (ADR-035): the sample template does not place
    // the note, so the printed page carries it under the text.
    expect(fields['amounts.roundingNote']).toMatch(/مضرب ۱۰ ریال/);
    const html = contractHtml(
      {
        title: 'قرارداد',
        sample: true,
        lender: { entityId: 'aramesh', name: 'شرکت آرامش ثروت' },
        body: '# مبلغ\n\nوام {{loan.amount}} و جمع اقساط {{totalObligation.amount}} است. {{cancellation.penaltyPercent}}',
      },
      fields,
      table.map((i) => ({ index: '', dueOn: '', amount: i.amount })),
    );
    expect(html).toContain('۹۶۰٬۰۰۰ تومان و ۷ ریال');
    expect(html).toContain('مضرب ۱۰ ریال');
  });

  it('is printed once; a later template changes neither its PDF nor its hash', async () => {
    const { applicationId } = await approved(false);
    const made = await w.staff(w.completion, 'POST', '/contracts', {
      creditApplicationId: applicationId,
    });
    await print(made.body);
    const printed = await w.staff(w.completion, 'GET', `/contracts/${made.body['id'] as string}`);
    const sha = createHash('sha256').update(FAKE_PDF).digest('hex');
    expect(printed.body).toMatchObject({
      status: 'ready',
      sha256: sha,
      sizeBytes: FAKE_PDF.length,
    });

    // A new template is approved by two people…
    const proposal = await propose(`${BODY}\n\n# نسخه دوم\n\nمتن تازه.`);
    expect(
      (
        await w.staff(
          strategyB,
          'POST',
          `/config/proposals/${proposal.body['id'] as string}/approve`,
        )
      ).status,
    ).toBe(200);
    // …and printing again changes nothing; the stored PDF is the same bytes.
    await print(made.body, () => Promise.resolve(Buffer.from('%PDF-1.4\n% other\n%%EOF\n')));
    const after = await w.staff(w.completion, 'GET', `/contracts/${made.body['id'] as string}`);
    expect(after.body).toMatchObject({
      sha256: sha,
      templateVersionId: printed.body['templateVersionId'],
    });
    const { rows } = await h.owner.query<Row>('SELECT storage_key FROM contracts WHERE id = $1', [
      made.body['id'],
    ]);
    const stored = await h.app
      .get<ObjectStorage>(OBJECT_STORAGE)
      .get('private', rows[0]?.['storage_key'] as string);
    expect(createHash('sha256').update(stored).digest('hex')).toBe(sha);
    await expect(
      h.owner.query(`UPDATE contracts SET sha256 = repeat('0', 64) WHERE id = $1`, [
        made.body['id'],
      ]),
    ).rejects.toThrow(/fixed/);

    // A contract made now takes the new template version.
    const { applicationId: later } = await approved(false);
    const fresh = await w.staff(w.completion, 'POST', '/contracts', { creditApplicationId: later });
    expect(fresh.body['templateVersionId']).not.toBe(printed.body['templateVersionId']);
  });

  it('is accepted by the borrower and each guarantor themselves, with a code', async () => {
    const { patient, guarantor, applicationId } = await approved(true);
    const made = await w.staff(w.completion, 'POST', '/contracts', {
      creditApplicationId: applicationId,
    });
    const id = made.body['id'] as string;
    expect((made.body['parties'] as Body[]).map((p) => p['role'])).toEqual([
      'borrower',
      'guarantor',
    ]);
    // Not before it is printed.
    expect(
      (await w.as(patient, 'POST', `/me/contracts/${id}/acceptance/request`, { role: 'borrower' }))
        .body['error'],
    ).toBe('not_ready');
    await print(made.body);

    const accept = async (who: Patient, role: string) => {
      const sent = await w.as(who, 'POST', `/me/contracts/${id}/acceptance/request`, { role });
      expect(sent.status).toBe(201);
      return w.as(who, 'POST', `/me/contracts/${id}/acceptance`, {
        role,
        code: h.sms.lastCodeFor(who.mobile),
      });
    };
    // A stranger, and a party in the other role, find nothing.
    const stranger = await w.patient();
    expect((await w.as(stranger, 'GET', `/me/contracts/${id}`)).status).toBe(404);
    expect(
      (await w.as(patient, 'POST', `/me/contracts/${id}/acceptance/request`, { role: 'guarantor' }))
        .status,
    ).toBe(404);
    // A wrong code accepts nothing; the right one, of the same request, does.
    expect(
      (await w.as(patient, 'POST', `/me/contracts/${id}/acceptance/request`, { role: 'borrower' }))
        .status,
    ).toBe(201);
    expect(
      (
        await w.as(patient, 'POST', `/me/contracts/${id}/acceptance`, {
          role: 'borrower',
          code: '000000',
        })
      ).status,
    ).toBe(401);
    const first = await w.as(patient, 'POST', `/me/contracts/${id}/acceptance`, {
      role: 'borrower',
      code: h.sms.lastCodeFor(patient.mobile),
    });
    expect(first.status).toBe(201);
    expect(first.body['status']).toBe('ready');
    const second = await accept(guarantor as Patient, 'guarantor');
    expect(second.body['status']).toBe('accepted');
    expect((second.body['parties'] as Body[]).every((p) => p['acceptedAt'] !== null)).toBe(true);

    // Each acceptance names the PDF it was of.
    const { rows } = await h.owner.query<Row>(
      `SELECT a.pdf_sha256, c.sha256 FROM contract_acceptances a JOIN contracts c ON c.id = a.contract_id
        WHERE c.id = $1`,
      [id],
    );
    expect(rows).toHaveLength(2);
    expect(rows.every((r) => r['pdf_sha256'] === r['sha256'])).toBe(true);
    // The parties see it; their link is logged.
    expect((await w.as(guarantor as Patient, 'GET', '/me/contracts')).body).toEqual(
      expect.arrayContaining([expect.objectContaining({ id, status: 'accepted' })]),
    );
    const link = await w.as(patient, 'GET', `/me/contracts/${id}/link`);
    expect(link.status).toBe(200);
    expect(link.body['url']).toEqual(expect.any(String));
    // Each party's own view says which party is the viewer (task 4-4); staff's does not.
    const mineOf = async (who: Patient) =>
      ((await w.as(who, 'GET', `/me/contracts/${id}`)).body['parties'] as Body[]).map((p) => [
        p['role'],
        p['mine'],
      ]);
    expect(await mineOf(patient)).toEqual([
      ['borrower', true],
      ['guarantor', false],
    ]);
    expect(await mineOf(guarantor as Patient)).toEqual([
      ['borrower', false],
      ['guarantor', true],
    ]);
    const staffView = await w.staff(w.completion, 'GET', `/contracts/${id}`);
    expect((staffView.body['parties'] as Body[]).every((p) => !('mine' in p))).toBe(true);
  });
});

describe('the PDF (ADR-033)', () => {
  it('is printed by headless Chromium, Persian, with nothing fetched', async () => {
    const renderer = new ChromiumPdfRenderer(process.env['PDF_BROWSER_PATH'] || undefined);
    try {
      const pdf = await renderer.render(
        contractHtml(
          {
            title: 'قرارداد وام درمان',
            sample: true,
            lender: { entityId: 'aramesh', name: 'شرکت آرامش ثروت' },
            body: BODY,
          },
          {
            'contract.number': '۱۴۰۵-۰۰۰۰۰۱',
            'contract.date': '۱۴۰۵/۰۷/۱۱',
            'lender.name': 'شرکت آرامش ثروت',
            'borrower.name': 'مریم <script>',
            'loan.amount': '۹۶۰٬۰۰۰ تومان',
            'cancellation.penaltyPercent': '۱۸٪',
          },
          [{ index: '۱', dueOn: '۱۴۰۵/۰۸/۱۱', amount: '۸۸٬۰۰۰ تومان' }],
        ),
      );
      expect(pdf.subarray(0, 5).toString('latin1')).toBe('%PDF-');
      expect(pdf.length).toBeGreaterThan(5_000);
      // The font is embedded, not fetched.
      expect(pdf.toString('latin1')).toMatch(/FontFile|Vazirmatn/);
    } finally {
      await renderer.onApplicationShutdown();
    }
  }, 60_000);
});
