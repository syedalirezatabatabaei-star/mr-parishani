/**
 * A funded purse of its own for the special-operations test (task 4-8), made through the
 * API as people would: a patient books, the doctor issues a proforma, the borrower applies
 * and consents, the credit units approve; case completion has the contract printed (by the
 * worker) and accepted, the paper received, the receipts approved by finance and the
 * application completed; then funded by two people. Its whole amount is unused, so the
 * test can cancel part of it. Codes are read where the stack keeps them (otp.json).
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { STACK, STACK_DIR } from './stack-config.ts';

type Body = Record<string, unknown>;
type Call = (method: string, path: string, token?: string, body?: unknown) => Promise<Body>;

const PDF = Buffer.from('%PDF-1.4\n1 0 obj << >> endobj\ntrailer << >>\n%%EOF\n');
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** The newest login code for this mobile other than `previous`, as the worker printed it. */
export async function codeFor(mobile: string, previous = ''): Promise<string> {
  const masked = `${mobile.slice(0, 3)}***${mobile.slice(-4)}`;
  for (let i = 0; i < 60; i++) {
    try {
      const codes = JSON.parse(readFileSync(resolve(STACK_DIR, 'otp.json'), 'utf8')) as Record<
        string,
        string
      >;
      const code = codes[masked];
      if (code && code !== previous) return code;
    } catch {
      // not written yet
    }
    await sleep(500);
  }
  throw new Error(`no code for ${masked}`);
}

async function upload(path: string, token: string, fields: Record<string, string>) {
  const form = new FormData();
  for (const [k, v] of Object.entries(fields)) form.append(k, v);
  form.append('file', new Blob([new Uint8Array(PDF)]), 'file.pdf');
  const res = await fetch(`${STACK.apiUrl}/api/v1${path}`, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}` },
    body: form,
  });
  const body = (await res.json()) as Body;
  if (res.status !== 201) throw new Error(`${path}: ${String(res.status)} ${JSON.stringify(body)}`);
  return body;
}

export async function fundedPurse(
  call: Call,
  who: {
    doctor: string;
    /** The center's manager: confirms, checks in and examines the visit. */
    center: string;
    completion: string;
    creditSpecialist: string;
    creditManager: string;
    finance: string;
    completionFinance: string;
  },
  workplaceId: string,
  options: {
    guarantor?: boolean;
    draftOnly?: boolean;
    /** ADR-050 screenshots: another plan and proforma lines (default: dental_isfahan, the visit). */
    planCode?: string;
    lines?: readonly Body[];
    /** Runs before the application goes to its decision (a wage-only split check). */
    beforeDecision?: (applicationId: string) => Promise<void>;
  } = {},
): Promise<{
  applicationId: string;
  purseId: string;
  mobile: string;
  guarantorMobile: string | null;
  /** The borrower's mobile access token (task 7-5: a ticket of theirs). */
  patientToken: string;
}> {
  const mobile = `914${String(Math.floor(Math.random() * 1e7)).padStart(7, '0')}`;
  await call('POST', '/auth/otp/request', undefined, { mobile: `0${mobile}` });
  const loginCode = await codeFor(mobile);
  const patient = String(
    (
      await call('POST', '/auth/otp/verify', undefined, {
        mobile: `0${mobile}`,
        code: loginCode,
        client: 'mobile',
      })
    )['accessToken'],
  );

  // A visit on the last free slot of the next two weeks (the tests take the first ones).
  const from = new Date().toISOString().slice(0, 10);
  const to = new Date(Date.now() + 13 * 86_400_000).toISOString().slice(0, 10);
  const slots = (await call(
    'GET',
    `/booking/workplaces/${workplaceId}/free-slots?from=${from}&to=${to}`,
    patient,
  )) as unknown as { startsAt: string }[];
  const slot = slots.at(-1);
  if (!slot) throw new Error('no free slot for the funded purse');
  const held = await call('POST', '/booking/appointments/hold', patient, {
    workplaceId,
    serviceCode: 'visit',
    startsAt: slot.startsAt,
  });
  const requested = await call(
    'POST',
    `/booking/appointments/${String(held['id'])}/request`,
    patient,
  );
  // A proforma is issued only once the visit is examined (owner 1405/07/23).
  const visit = `/booking/appointments/${String(held['id'])}`;
  if (requested['status'] === 'requested') {
    await call('POST', `${visit}/respond`, who.center, { decision: 'confirm' });
  }
  const mine = await call('GET', `/booking/me/appointments/${String(held['id'])}`, patient);
  await call('POST', `${visit}/check-in`, who.center, { code: mine['checkInCode'] });
  await call('POST', `${visit}/examined`, who.center);
  const proforma = await call('POST', '/proformas', who.doctor, {
    appointmentId: held['id'],
    lines: options.lines ?? [{ serviceCode: 'visit', quantity: 1, unitRial: '6000000' }],
  });
  const proformaId = String(proforma['id']);
  await call('POST', `/proformas/${proformaId}/issue`, who.doctor);
  await call('POST', `/me/proformas/${proformaId}/confirm`, patient);

  const app = await call('POST', '/me/credit-applications', patient, {
    proformaId,
    planCode: options.planCode ?? 'dental_isfahan',
    installmentCount: 12,
  });
  const applicationId = String(app['id']);
  // The owner's visual approval (1405/07/23): an application left as a draft, nothing funded.
  if (options.draftOnly) {
    return { applicationId, purseId: '', mobile, guarantorMobile: null, patientToken: patient };
  }
  await call('POST', `/me/credit-applications/${applicationId}/submit`, patient);
  await call('POST', `/me/credit-applications/${applicationId}/consent/request`, patient, {
    role: 'borrower',
  });
  const consentCode = await codeFor(mobile, loginCode);
  await call('POST', `/me/credit-applications/${applicationId}/consent`, patient, {
    role: 'borrower',
    code: consentCode,
  });
  for (const itemCode of ['national_card', 'job_proof', 'bank_statement']) {
    const sent = await upload(`/me/credit-applications/${applicationId}/documents`, patient, {
      role: 'borrower',
      itemCode,
    });
    await call(
      'POST',
      `/credit/applications/${applicationId}/documents/${String(sent['id'])}/decision`,
      who.completion,
      { decision: 'accept' },
    );
  }
  await call('POST', `/credit/applications/${applicationId}/ready-for-review`, who.completion);
  await call('POST', `/credit/applications/${applicationId}/score-sheets`, who.creditSpecialist, {
    subject: 'borrower',
    raw: {
      job: 'official',
      employmentStartedOn: { year: 1398, month: 1, day: 1 },
      coverage: 'full',
      obligationsRial: '1000000',
      newInstallmentRial: '4000000',
    },
  });
  // Task 6-9: a guarantor, introduced by the borrower, consents, is documented and scored.
  let guarantorMobile: string | null = null;
  // The guarantor accepts the contract too (doc 12 §2): their token and last code kept.
  let guarantorToken: string | null = null;
  let guarantorLastCode = '';
  if (options.guarantor) {
    guarantorMobile = `915${String(Math.floor(Math.random() * 1e7)).padStart(7, '0')}`;
    const invited = await call(
      'POST',
      `/me/credit-applications/${applicationId}/guarantors`,
      patient,
      {
        mobile: `0${guarantorMobile}`,
      },
    );
    await call('POST', '/auth/otp/request', undefined, { mobile: `0${guarantorMobile}` });
    const guarantorLogin = await codeFor(guarantorMobile);
    const guarantor = String(
      (
        await call('POST', '/auth/otp/verify', undefined, {
          mobile: `0${guarantorMobile}`,
          code: guarantorLogin,
          client: 'mobile',
        })
      )['accessToken'],
    );
    await call('POST', `/me/credit-applications/${applicationId}/consent/request`, guarantor, {
      role: 'guarantor',
    });
    guarantorLastCode = await codeFor(guarantorMobile, guarantorLogin);
    await call('POST', `/me/credit-applications/${applicationId}/consent`, guarantor, {
      role: 'guarantor',
      code: guarantorLastCode,
    });
    guarantorToken = guarantor;
    for (const itemCode of ['national_card', 'job_proof', 'bank_statement']) {
      const sent = await upload(`/me/credit-applications/${applicationId}/documents`, guarantor, {
        role: 'guarantor',
        itemCode,
      });
      await call(
        'POST',
        `/credit/applications/${applicationId}/documents/${String(sent['id'])}/decision`,
        who.completion,
        { decision: 'accept' },
      );
    }
    await call('POST', `/credit/applications/${applicationId}/score-sheets`, who.creditSpecialist, {
      subject: 'guarantor',
      guarantorId: String(invited['id']),
      raw: {
        job: 'official',
        employmentStartedOn: { year: 1395, month: 1, day: 1 },
        averageBalanceRial: '30000000',
        installmentRial: '900000',
        debts: 'none_or_very_low',
        independence: 'fully_independent',
      },
    });
  }
  await options.beforeDecision?.(applicationId);
  await call('POST', `/credit/applications/${applicationId}/to-decision`, who.creditSpecialist);
  const proposed = await call(
    'POST',
    `/credit/applications/${applicationId}/decisions`,
    who.creditSpecialist,
    { outcome: 'approved', reason: 'رتبه الف' },
  );
  await call(
    'POST',
    `/credit/applications/${applicationId}/decisions/${String(proposed['id'])}/confirm`,
    who.creditManager,
  );

  // Completion: the contract the worker prints, accepted; the paper; the receipts.
  const contract = await call('POST', '/contracts', who.completion, {
    creditApplicationId: applicationId,
  });
  const contractId = String(contract['id']);
  for (let i = 0; i < 120; i++) {
    const list = (await call(
      'GET',
      `/contracts?creditApplicationId=${applicationId}`,
      who.completion,
    )) as unknown as Body[];
    const status = list.find((c) => c['id'] === contractId)?.['status'];
    if (status && status !== 'generating') break;
    await sleep(500);
  }
  await call('POST', `/me/contracts/${contractId}/acceptance/request`, patient, {
    role: 'borrower',
  });
  await call('POST', `/me/contracts/${contractId}/acceptance`, patient, {
    role: 'borrower',
    code: await codeFor(mobile, consentCode),
  });
  if (guarantorToken && guarantorMobile) {
    await call('POST', `/me/contracts/${contractId}/acceptance/request`, guarantorToken, {
      role: 'guarantor',
    });
    await call('POST', `/me/contracts/${contractId}/acceptance`, guarantorToken, {
      role: 'guarantor',
      code: await codeFor(guarantorMobile, guarantorLastCode),
    });
  }
  const delivery = await call('POST', '/deliveries', who.completion, {
    creditApplicationId: applicationId,
    items: [{ kind: 'signed_contract', label: 'قرارداد امضاشده' }],
  });
  const deliveryId = String(delivery['id']);
  await call('POST', `/deliveries/${deliveryId}/receive`, who.completion, { method: 'in_person' });
  const itemId = String((delivery['items'] as Body[])[0]?.['id']);
  await call('POST', `/deliveries/${deliveryId}/items/${itemId}`, who.completion, {
    status: 'received',
  });
  await call('POST', `/deliveries/${deliveryId}/check`, who.completion);
  const status = await call('GET', `/completion/${applicationId}`, who.completion);
  for (const owed of status['owed'] as Body[]) {
    const kind = String(owed['kind']);
    const sent = await upload(`/me/completion/${applicationId}/receipts`, patient, {
      kind,
      amountRial: String(owed['expectedRial']),
      paidOn: from,
      reference: `REF-${kind}-${String(Date.now())}`,
    });
    await call('POST', `/receipts/${String(sent['id'])}/approve`, who.finance);
  }
  await call('POST', `/completion/${applicationId}/complete`, who.completion);

  // Funded: asked by one, approved by another.
  const asked = await call('POST', '/funding/requests', who.completionFinance, {
    creditApplicationId: applicationId,
  });
  const funded = await call(
    'POST',
    `/funding/requests/${String(asked['id'])}/approve`,
    who.finance,
  );
  return {
    applicationId,
    purseId: String(funded['purseId']),
    mobile,
    guarantorMobile,
    patientToken: patient,
  };
}
