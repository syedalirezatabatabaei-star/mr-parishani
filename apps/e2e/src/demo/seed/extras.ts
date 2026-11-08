/**
 * After the timeline, on the real clock (owner 1405/08/09): appointments of today and this
 * week at the first five centers, and cheque executions on overdue cases with a guarantor, so
 * the panel's calendars and the "cheques: execution" page are not empty. Through the API only.
 *
 * A borrower's cheque falls due a year after funding (loan.ts), so none is executable in the
 * demo's half-year; the guarantor brings a cheque dated to the overdue installments instead,
 * received and checked as any delivery. Its execution is proposed by collection and approved
 * by the collection manager and finance (two others, task 6-8). No outcome is recorded: the
 * cheques wait at the bank, and nothing here posts to the ledger.
 */
import { randomInt } from 'node:crypto';
import { secrets, setClock } from '../runtime.ts';
import type { DemoWorkplace } from './catalog.ts';
import {
  as,
  asPatient,
  patientAt,
  person,
  saveState,
  type Body,
  type Person,
  type SeedState,
} from './context.ts';
import { runLoan, type Stage } from './loan.ts';
import { DEMO } from './settings.ts';
import { introduce, makePatients } from './timeline.ts';

/** Per center (place index): the appointments added, confirmed or only requested. */
const APPOINTMENTS: [number, Stage[]][] = [
  [0, ['confirmed', 'confirmed', 'booked']],
  [1, ['confirmed']],
  [2, ['confirmed', 'confirmed', 'booked']],
  [3, ['booked']],
  [4, ['confirmed']],
];

/** How many overdue cases get a guarantor's cheque, and how far each goes. */
const EXECUTIONS: ('proposed' | 'collection_approved' | 'presented')[] = [
  'presented',
  'collection_approved',
  'proposed',
];

const DAY = 86_400_000;

export async function seedExtras(state: SeedState) {
  await setClock('real');
  const issues = ((state.data['issues'] as string[] | undefined) ??= []);
  await appointments(state, issues);
  await executions(state, issues);
}

async function appointments(state: SeedState, issues: string[]) {
  const places = state.data['places'] as DemoWorkplace[];
  const done = ((state.data['extraAppointments'] as number | undefined) ??= 0);
  const all = APPOINTMENTS.flatMap(([place, stages]) => stages.map((stage) => ({ place, stage })));
  for (const [k, a] of all.entries()) {
    if (k < done) continue;
    const place = places[a.place];
    if (!place) continue;
    makePatients(state, state.patients.length + 1);
    const patient = patientAt(state, state.patients.length - 1);
    patient.story = a.stage === 'confirmed' ? 'نوبت تأییدشده' : 'نوبت درخواست‌شده (منتظر مرکز)';
    try {
      await introduce(state, patient, place);
      await runLoan(state, { patient, place, stopAt: a.stage });
    } catch (error) {
      issues.push(`نوبت ${place.centerName}: ${(error as Error).message.slice(0, 200)}`);
    }
    state.data['extraAppointments'] = k + 1;
    saveState(state);
  }
}

interface QueueItem {
  caseId: string;
  borrowerMobile: string;
  maxDaysPastDue: number;
  overdueRial: string;
}

interface DemoCase {
  patient: number;
  guarantorIndex?: number;
  result?: { applicationId?: string };
}

/** A staff action by the first of `people` the API lets do it (the queues share the work). */
async function byEither(people: Person[], method: string, path: string, body?: unknown) {
  let last: unknown;
  for (const who of people) {
    try {
      return await as(who, method, path, body);
    } catch (error) {
      last = error;
      if (!(error instanceof Error) || !/→ 403 /.test(error.message)) throw error;
    }
  }
  throw last instanceof Error ? last : new Error(String(last));
}

async function executions(state: SeedState, issues: string[]) {
  const done = ((state.data['extraExecutions'] as string[] | undefined) ??= []);
  if (done.length >= EXECUTIONS.length) return;
  const cases = state.data['cases'] as DemoCase[];
  const queue = (await as(person(state, 'collman'), 'GET', '/collection/queue')) as unknown;
  const items = (
    Array.isArray(queue) ? queue : ((queue as Body)['items'] as unknown[])
  ) as QueueItem[];
  // The longest overdue first, of the cases whose borrower has a guarantor.
  const picked = items
    .map((it) => ({
      it,
      c: cases.find((c) => patientAt(state, c.patient).mobile === it.borrowerMobile),
    }))
    .filter((x) => x.c?.guarantorIndex !== undefined && x.c.result?.applicationId)
    .sort((a, b) => b.it.maxDaysPastDue - a.it.maxDaysPastDue)
    .slice(0, EXECUTIONS.length);
  const completion = [person(state, 'comp1'), person(state, 'comp2'), person(state, 'compfin')];
  const collection = [person(state, 'coll1'), person(state, 'coll2')];
  for (const [k, { it, c }] of picked.entries()) {
    if (!c || done.includes(it.caseId)) continue;
    const applicationId = String(c.result?.applicationId);
    const guarantor = patientAt(state, c.guarantorIndex ?? 0);
    try {
      // The guarantee's id, as the guarantor sees it.
      const mine = (await asPatient(
        guarantor,
        secrets().patientCode,
        'GET',
        '/me/guarantees',
      )) as unknown as { id: string; creditApplicationId: string }[];
      const guarantorId = mine.find((g) => g.creditApplicationId === applicationId)?.id;
      if (!guarantorId) throw new Error('no guarantee of the guarantor');
      // The guarantor's cheque for what is overdue, dated a week back, delivered and checked.
      const delivery = await byEither(completion, 'POST', '/deliveries', {
        creditApplicationId: applicationId,
        items: [{ kind: 'cheque', label: 'چک ضامن برای اقساط معوق' }],
      });
      const deliveryId = String(delivery['id']);
      await byEither(completion, 'POST', `/deliveries/${deliveryId}/receive`, {
        method: 'in_person',
      });
      const item = (delivery['items'] as Body[])[0];
      if (!item) throw new Error('delivery without its item');
      await byEither(completion, 'POST', `/deliveries/${deliveryId}/items/${String(item['id'])}`, {
        status: 'received',
      });
      const instrument = await byEither(
        completion,
        'POST',
        `/deliveries/${deliveryId}/instruments`,
        {
          itemId: String(item['id']),
          kind: 'cheque',
          issuer: { role: 'guarantor', guarantorId },
          amountRial: it.overdueRial,
          number:
            String(randomInt(100_000_000, 999_999_999)) + String(randomInt(1_000_000, 9_999_999)),
          bankName: 'بانک ملت',
          dueOn: new Date(Date.now() - 7 * DAY).toISOString().slice(0, 10),
          notes: `${DEMO}: چک ضامن به مبلغ اقساط معوق`,
        },
      );
      const instrumentId = String(instrument['id']);
      await byEither(completion, 'POST', `/instruments/${instrumentId}/sayad`);
      await byEither(completion, 'POST', `/instruments/${instrumentId}/verify`);
      await byEither(completion, 'POST', `/deliveries/${deliveryId}/check`);
      await byEither(completion, 'POST', `/deliveries/${deliveryId}/archive`, {
        location: 'گاوصندوق دفتر مرکزی، قفسه ۳',
      });
      // Proposed by collection; approved by the collection manager, then by finance.
      const execution = await byEither(collection, 'POST', '/instrument-executions', {
        instrumentId,
        reason: `${DEMO}: ${String(it.maxDaysPastDue)} روز معوق؛ پیگیری تلفنی بی‌نتیجه`,
      });
      const step = EXECUTIONS[k];
      const id = String(execution['id']);
      if (step !== 'proposed')
        await as(person(state, 'collman'), 'POST', `/instrument-executions/${id}/approve`, {});
      if (step === 'presented')
        await as(person(state, 'acc1'), 'POST', `/instrument-executions/${id}/approve`, {});
      done.push(it.caseId);
      saveState(state);
    } catch (error) {
      issues.push(`اجرای چک ${it.borrowerMobile}: ${(error as Error).message.slice(0, 200)}`);
    }
  }
}
