import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { CONFIG } from '../../src/common/config/config.port';
import { LEAD_CASES } from '../../src/common/lead/lead-cases.port';
import { DATABASE, type Database } from '../../src/db/database.module';
import { CreditNotifier } from '../../src/modules/credit/credit-notifier';
import { newMobile, startHarness, type Harness } from '../identity/harness';
import {
  eicar,
  startScanner,
  startStorage,
  type StartedScanner,
  type StartedStorage,
} from '../support/files';
import { BASE_DOCUMENTS, creditWorld, PDF, type Body, type Row } from './world';

/**
 * Task 3-5 part C (doc 10 §4): documents of a credit application, with a real S3-compatible
 * server (SeaweedFS) and a real clamd. The real type from the bytes, a malware scan, private
 * storage seen only through a signed link, every view in the access log (doc 04 §7), and a
 * rejection told to its owner without the reason.
 */

let storage: StartedStorage;
let scanner: StartedScanner;
let h: Harness;
let w: Awaited<ReturnType<typeof creditWorld>>;

const borrowerRaw = {
  job: 'self_employed_over_5',
  employmentStartedOn: { year: 1398, month: 1, day: 1 },
  coverage: 'full',
  obligationsRial: '1000000',
  newInstallmentRial: '4000000',
};

async function views(documentId: string) {
  const { rows } = await h.owner.query<Row>(
    `SELECT account_id FROM access_logs WHERE entity_type = 'credit_document' AND entity_id = $1`,
    [documentId],
  );
  return rows.map((r) => r['account_id']);
}

beforeAll(async () => {
  [storage, scanner] = await Promise.all([startStorage(), startScanner()]);
  Object.assign(process.env, storage.env, scanner.env);
  h = await startHarness();
  w = await creditWorld(h);
}, 600_000);

afterAll(async () => {
  await h.close();
  await Promise.all([storage.container.stop(), scanner.container.stop()]);
});

/** A submitted application of a new patient, the borrower consented. */
async function submitted() {
  const { patient, proformaId } = await w.confirmedProforma();
  const made = await w.as(patient, 'POST', '/me/credit-applications', {
    proformaId,
    planCode: 'dental_12',
    installmentCount: 12,
  });
  const applicationId = made.body['id'] as string;
  await w.as(patient, 'POST', `/me/credit-applications/${applicationId}/submit`);
  await w.consent(patient, applicationId, 'borrower');
  return { patient, applicationId };
}

describe('uploading (rule 28)', () => {
  it('takes a PDF or photo of a checklist item; refuses another type, malware, and an unknown item', async () => {
    const { patient, applicationId } = await submitted();
    const pdf = await w.upload(patient, applicationId, 'borrower', 'national_card', PDF);
    expect(pdf.status).toBe(201);
    expect(pdf.body).toMatchObject({
      itemCode: 'national_card',
      status: 'submitted',
      mime: 'application/pdf',
    });

    const text = await w.upload(
      patient,
      applicationId,
      'borrower',
      'job_proof',
      Buffer.from('just text, named .pdf'),
    );
    expect(text.status).toBe(400);
    expect(text.body['error']).toBe('unsupported_type');
    const infected = await w.upload(patient, applicationId, 'borrower', 'job_proof', eicar());
    expect(infected.status).toBe(400);
    expect(infected.body['error']).toBe('file_infected');
    const unknown = await w.upload(patient, applicationId, 'borrower', 'selfie', PDF);
    expect(unknown.status).toBe(400);
    expect(unknown.body['error']).toBe('not_in_checklist');
    // Not a guarantor of it: no guarantor's documents either.
    expect((await w.upload(patient, applicationId, 'guarantor', 'national_card', PDF)).status).toBe(
      404,
    );
    expect(
      (await w.upload(await w.patient(), applicationId, 'borrower', 'national_card', PDF)).status,
    ).toBe(404);

    // The file is in private storage, under a generated key, as uploaded.
    const { rows } = await h.owner.query<Row>(
      'SELECT storage_key, sha256 FROM credit_documents WHERE id = $1',
      [pdf.body['id']],
    );
    expect(rows[0]?.['storage_key']).toBe(
      `credit-documents/${applicationId}/${pdf.body['id'] as string}`,
    );
    await expect(
      h.owner.query(`UPDATE credit_documents SET storage_key = 'elsewhere' WHERE id = $1`, [
        pdf.body['id'],
      ]),
    ).rejects.toThrow(/only change its state/);
  });
});

describe('seeing a document (doc 04 §7)', () => {
  it('only through a short signed link; every view is logged; a stranger sees nothing', async () => {
    const { patient, applicationId } = await submitted();
    const sent = await w.upload(patient, applicationId, 'borrower', 'bank_statement', PDF);
    const id = sent.body['id'] as string;
    const own = await w.as(
      patient,
      'GET',
      `/me/credit-applications/${applicationId}/documents/${id}/link`,
    );
    expect(own.status).toBe(200);
    expect(own.body['expiresInSeconds']).toBe(300);
    const file = await fetch(own.body['url'] as string);
    expect(Buffer.from(await file.arrayBuffer()).equals(PDF)).toBe(true);
    // Task 9-3 (R12): a download, not a page the browser renders, and never cached.
    expect(file.headers.get('content-disposition')).toBe('attachment');
    expect(file.headers.get('cache-control')).toBe('private, no-store');
    const staff = await w.staff(
      w.completion,
      'GET',
      `/credit/applications/${applicationId}/documents/${id}/link`,
    );
    expect(staff.status).toBe(200);
    expect(await views(id)).toEqual([patient.id, w.completion.id]);
    expect(
      (
        await w.as(
          await w.patient(),
          'GET',
          `/me/credit-applications/${applicationId}/documents/${id}/link`,
        )
      ).status,
    ).toBe(404);
    // The doctor reads no credit application.
    expect(
      (await w.staff(w.doctor, 'GET', `/credit/applications/${applicationId}/documents/${id}/link`))
        .status,
    ).toBe(403);
  });
});

describe('deciding (doc 10 §4)', () => {
  it('a rejection with a reason is told to its owner (not the reason); a new upload follows; an accepted one stays', async () => {
    const { patient, applicationId } = await submitted();
    const sent = await w.upload(patient, applicationId, 'borrower', 'job_proof', PDF);
    const rejected = await w.staff(
      w.completion,
      'POST',
      `/credit/applications/${applicationId}/documents/${sent.body['id'] as string}/decision`,
      { decision: 'reject', reason: 'تصویر ناخوانا است' },
    );
    expect(rejected.status).toBe(201);
    expect(rejected.body).toMatchObject({ status: 'rejected', reason: 'تصویر ناخوانا است' });

    const { rows } = await h.owner.query<Row>(
      `SELECT id, payload, created_at FROM outbox_events WHERE event_type = 'credit.document_rejected' AND aggregate_id = $1`,
      [applicationId],
    );
    const sms: { mobile: string; text: string }[] = [];
    const notifier = new CreditNotifier(
      { register: () => undefined },
      h.app.get(CONFIG),
      h.app.get(LEAD_CASES),
      {
        sendText: (job) => Promise.resolve(void sms.push(job)),
      },
    );
    await notifier.handle(
      {
        id: rows[0]?.['id'] as string,
        type: 'credit.document_rejected',
        aggregateType: 'credit_application',
        aggregateId: applicationId,
        payload: rows[0]?.['payload'],
        occurredAt: (rows[0]?.['created_at'] as Date).toISOString(),
      },
      h.app.get<Database>(DATABASE),
    );
    expect(sms).toHaveLength(1);
    expect(sms[0]?.mobile).toBe(patient.mobile);
    expect(sms[0]?.text).toContain('مدرک شغل');
    expect(sms[0]?.text).not.toContain('ناخوانا');

    const again = await w.upload(patient, applicationId, 'borrower', 'job_proof', PDF);
    expect(again.status).toBe(201);
    const accepted = await w.staff(
      w.completion,
      'POST',
      `/credit/applications/${applicationId}/documents/${again.body['id'] as string}/decision`,
      { decision: 'accept' },
    );
    expect(accepted.body['status']).toBe('accepted');
    const third = await w.upload(patient, applicationId, 'borrower', 'job_proof', PDF);
    expect(third.status).toBe(409);
    expect(third.body['error']).toBe('document_already_accepted');
    // Only case completion decides.
    expect(
      (
        await w.staff(
          w.creditSpecialist,
          'POST',
          `/credit/applications/${applicationId}/documents/${again.body['id'] as string}/decision`,
          {
            decision: 'accept',
          },
        )
      ).status,
    ).toBe(403);
  });
});

describe('the checklist (doc 10 §4)', () => {
  it('asks a job’s items once the sheet names the job; a guarantor uploads their own', async () => {
    const { patient, applicationId } = await submitted();
    await w.documented(patient, applicationId, 'borrower');
    expect(
      (
        await w.staff(
          w.completion,
          'POST',
          `/credit/applications/${applicationId}/ready-for-review`,
        )
      ).status,
    ).toBe(201);
    const before = await w.as(patient, 'GET', `/me/credit-applications/${applicationId}/documents`);
    const codes = (b: Body) =>
      ((b['people'] as Body[])[0]?.['items'] as Body[]).map((i) => i['itemCode']);
    expect(codes(before.body)).toEqual([...BASE_DOCUMENTS]);

    await w.staff(
      w.creditSpecialist,
      'POST',
      `/credit/applications/${applicationId}/score-sheets`,
      { subject: 'borrower', raw: borrowerRaw },
    );
    const after = await w.as(patient, 'GET', `/me/credit-applications/${applicationId}/documents`);
    expect(codes(after.body)).toEqual([...BASE_DOCUMENTS, 'insurance_record']);

    const mobile = newMobile();
    await w.as(patient, 'POST', `/me/credit-applications/${applicationId}/guarantors`, {
      mobile: `0${mobile}`,
    });
    const guarantor = await w.patient(mobile);
    expect(
      (await w.upload(guarantor, applicationId, 'guarantor', 'national_card', PDF)).status,
    ).toBe(201);
    expect(
      (await w.upload(guarantor, applicationId, 'borrower', 'national_card', PDF)).status,
    ).toBe(404);
    const theirs = await w.as(
      guarantor,
      'GET',
      `/me/credit-applications/${applicationId}/documents`,
    );
    expect((theirs.body['people'] as Body[]).map((p) => p['role'])).toEqual(['guarantor']);
    const all = await w.staff(
      w.completion,
      'GET',
      `/credit/applications/${applicationId}/documents`,
    );
    expect((all.body['people'] as Body[]).map((p) => p['role'])).toEqual(['borrower', 'guarantor']);
  });
});
