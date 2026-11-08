import { expect } from 'vitest';
import { call, type Harness, type LoggedInAccount } from '../identity/harness';

type Row = Record<string, unknown>;

/**
 * An appointment brought to `examined` the way a center does it (doc 08 §7): confirmed if it
 * still waits for the center, checked in with the code the patient holds, examined. A
 * proforma is issued only after this (owner 1405/07/23). `center` manages the workplace;
 * `patientToken` is the patient's own session.
 */
export async function examineAppointment(
  h: Harness,
  center: LoggedInAccount,
  patientToken: string,
  appointmentId: string,
): Promise<void> {
  const status = async () =>
    (await h.owner.query<Row>('SELECT status FROM appointments WHERE id = $1', [appointmentId]))
      .rows[0]?.['status'];
  const asCenter = (path: string, body?: unknown) =>
    call(h, 'POST', `/booking/appointments/${appointmentId}/${path}`, {
      bearer: center.access,
      ...(body === undefined ? {} : { body }),
    });
  if ((await status()) === 'requested') {
    const confirmed = await asCenter('respond', { decision: 'confirm' });
    expect(confirmed.status, JSON.stringify(confirmed.body)).toBe(201);
  }
  if ((await status()) === 'confirmed') {
    const mine = await call(h, 'GET', `/booking/me/appointments/${appointmentId}`, {
      bearer: patientToken,
    });
    const code = mine.body['checkInCode'] as string;
    const checked = await asCenter('check-in', { code });
    expect(checked.status, JSON.stringify(checked.body)).toBe(201);
  }
  const done = await asCenter('examined');
  expect(done.status, JSON.stringify(done.body)).toBe(201);
  expect(await status()).toBe('examined');
}
