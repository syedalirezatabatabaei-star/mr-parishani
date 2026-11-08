import { randomUUID } from 'node:crypto';
import { expect } from 'vitest';
import { CONFIG } from '../../src/common/config/config.port';
import { OUTBOX } from '../../src/common/events/outbox.port';
import { OBJECT_STORAGE, type ObjectStorage } from '../../src/common/storage/object-storage.port';
import { DATABASE, type Database } from '../../src/db/database.module';
import { ContractPrinter } from '../../src/modules/contract/contract-printer';
import type { Harness, LoggedInAccount } from '../identity/harness';
import { PDF, type Body, type creditWorld, type Patient } from './world';

/**
 * The path from an application in review to a funded purse (doc 12 §2–§5), as the funding
 * tests take it: decided, contract printed and accepted, papers checked, receipts approved
 * by finance, completed, funded. For tests that start from there (task 4-6b).
 */
type World = Awaited<ReturnType<typeof creditWorld>>;

const alef = {
  job: 'official',
  employmentStartedOn: { year: 1398, month: 1, day: 1 },
  coverage: 'full',
  obligationsRial: '1000000',
  newInstallmentRial: '4000000',
};

export function fundingSteps(
  h: Harness,
  w: World,
  people: { manager: LoggedInAccount; finance: LoggedInAccount },
) {
  async function decide(applicationId: string) {
    await w.staff(
      w.creditSpecialist,
      'POST',
      `/credit/applications/${applicationId}/score-sheets`,
      {
        subject: 'borrower',
        raw: alef,
      },
    );
    await w.staff(w.creditSpecialist, 'POST', `/credit/applications/${applicationId}/to-decision`);
    const proposed = await w.staff(
      w.creditSpecialist,
      'POST',
      `/credit/applications/${applicationId}/decisions`,
      { outcome: 'approved', reason: 'رتبه الف' },
    );
    const confirmed = await w.staff(
      people.manager,
      'POST',
      `/credit/applications/${applicationId}/decisions/${proposed.body['id'] as string}/confirm`,
    );
    expect(confirmed.status).toBe(201);
  }

  /** An approved application of one borrower, the patient themselves. */
  async function approved(planCode?: string) {
    const { patient, applicationId } = await w.inReview(undefined, undefined, undefined, planCode);
    await decide(applicationId);
    return { patient, applicationId };
  }

  async function uploadReceipt(p: Patient, applicationId: string, fields: Record<string, string>) {
    const form = new FormData();
    for (const [k, v] of Object.entries(fields)) form.append(k, v);
    form.append('file', new Blob([new Uint8Array(PDF)]), 'receipt.pdf');
    const res = await fetch(`${h.baseUrl}/me/completion/${applicationId}/receipts`, {
      method: 'POST',
      headers: { authorization: `Bearer ${p.token}` },
      body: form,
    });
    return { status: res.status, body: (await res.json()) as Body };
  }

  /**
   * Contract, acceptance, papers, receipts approved by finance: everything before completion.
   * `options.guarantors` accept the contract too; `options.items` are expected in the delivery
   * besides the signed contract, all received; `options.papers` runs before the check (to
   * register and verify instruments).
   */
  async function ready(
    borrower: Patient,
    applicationId: string,
    options: {
      guarantors?: readonly Patient[];
      items?: readonly { kind: string; label: string }[];
      papers?: (deliveryId: string, items: readonly Body[]) => Promise<void>;
    } = {},
  ) {
    const contract = await w.staff(w.completion, 'POST', '/contracts', {
      creditApplicationId: applicationId,
    });
    expect(contract.status).toBe(201);
    const contractId = contract.body['id'] as string;
    await h.app.get<Database>(DATABASE).transaction((tx) =>
      new ContractPrinter(
        { register: () => undefined },
        h.app.get(CONFIG),
        h.app.get(OUTBOX),
        { render: () => Promise.resolve(Buffer.from('%PDF-1.4\n%%EOF\n')) },
        h.app.get<ObjectStorage>(OBJECT_STORAGE),
      ).handle(
        {
          id: randomUUID(),
          type: 'contract.requested',
          aggregateType: 'contract',
          aggregateId: contractId,
          payload: { contractId, creditApplicationId: applicationId },
          occurredAt: new Date().toISOString(),
        },
        tx,
      ),
    );
    await w.as(borrower, 'POST', `/me/contracts/${contractId}/acceptance/request`, {
      role: 'borrower',
    });
    let accepted = await w.as(borrower, 'POST', `/me/contracts/${contractId}/acceptance`, {
      role: 'borrower',
      code: h.sms.lastCodeFor(borrower.mobile),
    });
    for (const g of options.guarantors ?? []) {
      await w.as(g, 'POST', `/me/contracts/${contractId}/acceptance/request`, {
        role: 'guarantor',
      });
      accepted = await w.as(g, 'POST', `/me/contracts/${contractId}/acceptance`, {
        role: 'guarantor',
        code: h.sms.lastCodeFor(g.mobile),
      });
    }
    // Accepted by all: the last party's acceptance completes it.
    expect(accepted.body['status']).toBe('accepted');
    const delivery = await w.staff(w.completion, 'POST', '/deliveries', {
      creditApplicationId: applicationId,
      items: [{ kind: 'signed_contract', label: 'قرارداد امضاشده' }, ...(options.items ?? [])],
    });
    const deliveryId = delivery.body['id'] as string;
    await w.staff(w.completion, 'POST', `/deliveries/${deliveryId}/receive`, {
      method: 'in_person',
    });
    for (const item of delivery.body['items'] as Body[]) {
      await w.staff(
        w.completion,
        'POST',
        `/deliveries/${deliveryId}/items/${item['id'] as string}`,
        { status: 'received' },
      );
    }
    await options.papers?.(deliveryId, delivery.body['items'] as Body[]);
    await w.staff(w.completion, 'POST', `/deliveries/${deliveryId}/check`);
    const status = await w.staff(w.completion, 'GET', `/completion/${applicationId}`);
    const receipts: Record<string, string> = {};
    for (const owed of status.body['owed'] as Body[]) {
      const kind = owed['kind'] as string;
      const sent = await uploadReceipt(borrower, applicationId, {
        kind,
        amountRial: owed['expectedRial'] as string,
        paidOn: '2026-10-01',
        reference: `REF-${kind}-${randomUUID().slice(0, 8)}`,
      });
      expect(sent.status).toBe(201);
      receipts[kind] = sent.body['id'] as string;
      const done = await w.staff(
        people.finance,
        'POST',
        `/receipts/${sent.body['id'] as string}/approve`,
      );
      expect(done.body['status']).toBe('approved');
    }
    return { receipts, deliveryId };
  }

  /** Contract, acceptance, papers, receipts approved by finance, completion. */
  async function complete(borrower: Patient, applicationId: string) {
    const { receipts } = await ready(borrower, applicationId);
    expect(
      (await w.staff(w.completion, 'POST', `/completion/${applicationId}/complete`)).status,
    ).toBe(201);
    return { receipts };
  }

  /** Asked by case completion, approved by finance: the purse funded. */
  async function fund(applicationId: string): Promise<string> {
    const asked = await w.staff(w.completion, 'POST', '/funding/requests', {
      creditApplicationId: applicationId,
    });
    const done = await w.staff(
      people.finance,
      'POST',
      `/funding/requests/${asked.body['id'] as string}/approve`,
    );
    expect(done.status).toBe(201);
    return done.body['purseId'] as string;
  }

  return { decide, approved, ready, complete, fund };
}
