import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startHarness, type Harness } from '../identity/harness';
import { startStorage, type StartedStorage } from '../support/files';
import { creditWorld, PDF, type Row } from './world';

/**
 * Rule 28, fail-closed (owner 1405/07/18, after the local clamd container was found stopped):
 * with the scanner configured but not answering, an upload is refused with
 * `scanner_unavailable` and nothing is kept, neither the row nor the object. Real storage
 * (SeaweedFS); the scanner points at a port where nothing listens.
 */

let storage: StartedStorage;
let h: Harness;
let w: Awaited<ReturnType<typeof creditWorld>>;

beforeAll(async () => {
  storage = await startStorage();
  Object.assign(process.env, storage.env, { CLAMAV_HOST: '127.0.0.1', CLAMAV_PORT: '1' });
  h = await startHarness();
  w = await creditWorld(h);
}, 600_000);

afterAll(async () => {
  await h.close();
  await storage.container.stop();
});

describe('the scanner away (rule 28)', () => {
  it('refuses an upload and keeps nothing', async () => {
    const { patient, proformaId } = await w.confirmedProforma();
    const made = await w.as(patient, 'POST', '/me/credit-applications', {
      proformaId,
      planCode: 'dental_12',
      installmentCount: 12,
    });
    const applicationId = made.body['id'] as string;
    await w.as(patient, 'POST', `/me/credit-applications/${applicationId}/submit`);
    await w.consent(patient, applicationId, 'borrower');

    const sent = await w.upload(patient, applicationId, 'borrower', 'national_card', PDF);
    expect(sent.status).toBe(503);
    expect(sent.body['error']).toBe('scanner_unavailable');

    const { rows } = await h.owner.query<Row>(
      'SELECT count(*)::int AS n FROM credit_documents WHERE credit_application_id = $1',
      [applicationId],
    );
    expect(rows[0]?.['n']).toBe(0);
  });
});
