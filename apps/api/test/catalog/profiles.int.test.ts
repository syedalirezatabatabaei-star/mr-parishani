import sharp from 'sharp';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { CONFIG, type ConfigPort } from '../../src/common/config/config.port';
import {
  MALWARE_SCANNER,
  type MalwareScanner,
} from '../../src/common/security/malware-scanner.port';
import { OBJECT_STORAGE, type ObjectStorage } from '../../src/common/storage/object-storage.port';
import { DATABASE, type Database } from '../../src/db/database.module';
import { ClamdScanner } from '../../src/infra/clamd';
import { MediaWorker } from '../../src/modules/catalog/media-worker';
import { VIDEO_TRANSCODER, type VideoTranscoder } from '../../src/modules/catalog/video-transcoder';
import {
  eicar,
  startScanner,
  startStorage,
  type StartedScanner,
  type StartedStorage,
} from '../support/files';
import { councilNumber, nationalId, sheba } from './fixtures';
import {
  call,
  grantRole,
  loggedInAccount,
  newIp,
  startHarness,
  type Harness,
  type LoggedInAccount,
} from '../identity/harness';

/**
 * Task 2-8 (doc 08 §10, ADR-029): doctors' public profiles and their media. Acceptance: the
 * first half of doc 08 §15 test 10 (an unpublished profile cannot be reached from outside;
 * a changed slug answers 301), and a file with a fake extension is refused. Against a real
 * S3-compatible server (SeaweedFS) and a real clamd.
 */

let h: Harness;
let storage: StartedStorage;
let scanner: StartedScanner;
let worker: MediaWorker;
let specialist: LoggedInAccount;
let networkManager: LoggedInAccount;
let approver: LoggedInAccount;

type Body = Record<string, unknown>;
type Row = Record<string, unknown>;
const reason = { reason: 'آزمون پروفایل' };
let counter = 0;
/** A slug met nowhere else in this run. */
const slug = (base: string) => `${base}-${String(Date.now() % 100_000)}-${String(++counter)}`;

const staff = (who: LoggedInAccount, method: string, path: string, body?: unknown) =>
  call(h, method, path, { bearer: who.access, ...(body === undefined ? {} : { body }) });

/** GET without following a redirect, as the public (no session). */
async function publicGet(path: string) {
  const res = await fetch(`${h.baseUrl}${path}`, {
    redirect: 'manual',
    headers: { 'x-forwarded-for': newIp() },
  });
  const text = await res.text();
  return {
    status: res.status,
    location: res.headers.get('location'),
    // A redirect carries a text body; only JSON is read.
    body: (res.headers.get('content-type') ?? '').includes('json')
      ? (JSON.parse(text) as Body)
      : {},
  };
}

async function upload(who: LoggedInAccount, doctorId: string, file: Buffer, name: string) {
  const form = new FormData();
  form.append('file', new Blob([new Uint8Array(file)]), name);
  const res = await fetch(`${h.baseUrl}/catalog/doctors/${doctorId}/media`, {
    method: 'POST',
    headers: { authorization: `Bearer ${who.access}`, 'x-forwarded-for': newIp() },
    body: form,
  });
  return { status: res.status, body: (await res.json()) as Body };
}

interface Clinic {
  centerId: string;
  manager: LoggedInAccount;
  doctorId: string;
}

async function clinic(): Promise<Clinic> {
  const created = await staff(specialist, 'POST', '/catalog/centers', {
    // Owner 1405/07/27: the registration form requires the contract term.
    contractTerm: { startsOn: '2026-10-01', months: 12 },
    personType: 'natural',
    identifier: nationalId(),
    name: 'کلینیک پروفایل',
    cityCode: 'tehran',
    sheba: sheba(),
    accountHolderName: 'صاحب حساب',
    treatmentFieldCodes: ['dental'],
  });
  expect(created.status).toBe(201);
  const centerId = created.body['id'] as string;
  const setAll = async (status: string) => {
    const detail = await staff(specialist, 'GET', `/catalog/centers/${centerId}`);
    for (const doc of detail.body['documents'] as { code: string }[]) {
      await staff(specialist, 'PUT', `/catalog/centers/${centerId}/documents/${doc.code}`, {
        status,
      });
    }
  };
  await setAll('received');
  await staff(specialist, 'POST', `/catalog/centers/${centerId}/submit`, reason);
  await setAll('verified');
  const proposed = await staff(
    specialist,
    'POST',
    `/catalog/centers/${centerId}/activation-requests`,
    reason,
  );
  await staff(approver, 'POST', `/catalog/requests/${proposed.body['id'] as string}/approve`, {});
  const detail = await staff(specialist, 'GET', `/catalog/centers/${centerId}`);
  const [branch] = detail.body['branches'] as { id: string }[];
  const manager = await loggedInAccount(h, 'center');
  await grantRole(h, manager.id, 'center_manager', {
    kind: 'center',
    nodeId: created.body['nodeId'] as string,
  });
  const doc = await staff(specialist, 'POST', '/catalog/doctors', {
    // Owner 1405/07/27: the registration form requires the contract term.
    contractTerm: { startsOn: '2026-10-01', months: 12 },
    name: 'دکتر نگار زرین‌مکان',
    medicalCouncilNumber: councilNumber(),
    treatmentFieldCodes: ['dental'],
    workplace: { kind: 'branch', branchId: branch?.id },
    ...reason,
  });
  expect(doc.status).toBe(201);
  return { centerId, manager, doctorId: doc.body['id'] as string };
}

async function photo(width = 900) {
  return sharp({ create: { width, height: 600, channels: 3, background: '#5b8def' } })
    .withExif({ IFD0: { Make: 'Camera', Copyright: 'Someone' } })
    .jpeg()
    .toBuffer();
}

async function publish(c: Clinic, content: Body) {
  expect(
    (
      await staff(c.manager, 'PUT', `/catalog/doctors/${c.doctorId}/profile/draft`, {
        ...content,
        ...reason,
      })
    ).status,
  ).toBe(200);
  const submitted = await staff(
    c.manager,
    'POST',
    `/catalog/doctors/${c.doctorId}/profile/submit`,
    reason,
  );
  expect(submitted.status).toBe(201);
  return staff(
    specialist,
    'POST',
    `/catalog/profile-versions/${submitted.body['id'] as string}/approve`,
    reason,
  );
}

async function objectStatus(url: string) {
  return (await fetch(url)).status;
}

beforeAll(async () => {
  [storage, scanner] = await Promise.all([startStorage(), startScanner()]);
  Object.assign(process.env, storage.env, scanner.env);
  h = await startHarness();
  worker = h.app.get(MediaWorker);
  [specialist, networkManager, approver] = await Promise.all([
    loggedInAccount(h, 'staff'),
    loggedInAccount(h, 'staff'),
    loggedInAccount(h, 'staff'),
  ]);
  await grantRole(h, specialist.id, 'network_specialist', { kind: 'city', code: 'tehran' });
  await grantRole(h, networkManager.id, 'network_manager');
  await grantRole(h, approver.id, 'network_manager');
  await staff(networkManager, 'POST', '/catalog/fields', {
    code: 'dental',
    name: 'دندانپزشکی',
    ...reason,
  });
}, 300_000);

afterAll(async () => {
  await h.close();
  await Promise.all([storage.container.stop(), scanner.container.stop()]);
});

describe('doc 08 §15 test 10, first half: nothing unpublished is public; a new slug is a 301', () => {
  it('draft and review are not found from outside; the approved version is', async () => {
    const c = await clinic();
    const first = slug('dr-negar-zarrinmakan');
    const created = await staff(specialist, 'POST', `/catalog/doctors/${c.doctorId}/profile`, {
      slug: first,
      ...reason,
    });
    expect(created.status).toBe(201);
    expect(await publicGet(`/public/doctors/${first}`)).toMatchObject({ status: 404 });

    await staff(c.manager, 'PUT', `/catalog/doctors/${c.doctorId}/profile/draft`, {
      specialtyTitle: 'متخصص ارتودنسي',
      biography: 'بيوگرافي',
      ...reason,
    });
    const submitted = await staff(
      c.manager,
      'POST',
      `/catalog/doctors/${c.doctorId}/profile/submit`,
      reason,
    );
    expect(submitted.status).toBe(201);
    expect(await publicGet(`/public/doctors/${first}`)).toMatchObject({ status: 404 });
    // Editing what is in review is refused.
    const edit = await staff(c.manager, 'PUT', `/catalog/doctors/${c.doctorId}/profile/draft`, {
      biography: 'دیگر',
      ...reason,
    });
    expect(edit).toMatchObject({ status: 409, body: { error: 'profile_in_review' } });

    // The manager may not approve; the network specialist does.
    const byManager = await staff(
      c.manager,
      'POST',
      `/catalog/profile-versions/${submitted.body['id'] as string}/approve`,
      reason,
    );
    expect(byManager.status).toBe(403);
    const approved = await staff(
      specialist,
      'POST',
      `/catalog/profile-versions/${submitted.body['id'] as string}/approve`,
      reason,
    );
    expect(approved.status).toBe(201);

    const shown = await publicGet(`/public/doctors/${first}`);
    expect(shown.status).toBe(200);
    expect(shown.body).toMatchObject({
      slug: first,
      doctor: { id: c.doctorId, name: 'دکتر نگار زرین‌مکان' },
      // Normalized before it was stored (rule 23).
      specialtyTitle: 'متخصص ارتودنسی',
      biography: 'بیوگرافی',
      treatmentFields: [{ code: 'dental', name: 'دندانپزشکی' }],
      photo: null,
      video: null,
    });
    expect(shown.body['withSepehrSince']).toEqual(expect.any(String));
    expect(await publicGet(`/public/doctors/${slug('nobody')}`)).toMatchObject({ status: 404 });
  });

  it('a changed slug redirects, 301, from every earlier one; slugs are never reused', async () => {
    const c = await clinic();
    const [a, b, d] = [slug('dr-a'), slug('dr-b'), slug('dr-c')];
    await staff(specialist, 'POST', `/catalog/doctors/${c.doctorId}/profile`, {
      slug: a,
      ...reason,
    });
    expect((await publish(c, { biography: 'متن' })).status).toBe(201);

    // Only the network changes an address.
    const byManager = await staff(c.manager, 'PUT', `/catalog/doctors/${c.doctorId}/profile/slug`, {
      slug: b,
      ...reason,
    });
    expect(byManager.status).toBe(403);
    for (const next of [b, d]) {
      const res = await staff(specialist, 'PUT', `/catalog/doctors/${c.doctorId}/profile/slug`, {
        slug: next,
        ...reason,
      });
      expect(res.status).toBe(200);
    }
    for (const old of [a, b]) {
      const res = await publicGet(`/public/doctors/${old}`);
      expect(res.status).toBe(301);
      expect(res.location).toBe(`/api/v1/public/doctors/${d}`);
    }
    expect((await publicGet(`/public/doctors/${d}`)).status).toBe(200);

    // Another doctor can never take an address this one had.
    const other = await clinic();
    const taken = await staff(specialist, 'POST', `/catalog/doctors/${other.doctorId}/profile`, {
      slug: a,
      ...reason,
    });
    expect(taken).toMatchObject({ status: 409, body: { error: 'slug_taken' } });
    // Not a Latin slug: refused by the schema.
    const persian = await staff(specialist, 'POST', `/catalog/doctors/${other.doctorId}/profile`, {
      slug: 'دکتر-نگار',
      ...reason,
    });
    expect(persian.status).toBe(400);
    // The history is append-only.
    await expect(
      h.owner.query('UPDATE doctor_profile_slugs SET slug = $1 WHERE slug = $2', [slug('x'), a]),
    ).rejects.toThrow();
  });
});

describe('uploads: the bytes decide (rule 28)', () => {
  it('refuses a fake extension, a mismatched one and an unknown type, storing nothing', async () => {
    const c = await clinic();
    await staff(specialist, 'POST', `/catalog/doctors/${c.doctorId}/profile`, {
      slug: slug('dr-upload'),
      ...reason,
    });
    const count = async () =>
      Number(
        (
          await h.owner.query<Row>(
            'SELECT count(*)::int AS n FROM media_assets WHERE doctor_id = $1',
            [c.doctorId],
          )
        ).rows[0]?.['n'],
      );
    const pdf = Buffer.from('%PDF-1.7\n1 0 obj << >> endobj\n');
    expect(await upload(c.manager, c.doctorId, pdf, 'photo.jpg')).toMatchObject({
      status: 400,
      body: { error: 'unsupported_type' },
    });
    const jpeg = await photo();
    expect(await upload(c.manager, c.doctorId, jpeg, 'photo.png')).toMatchObject({
      status: 400,
      body: { error: 'type_mismatch' },
    });
    expect(await upload(c.manager, c.doctorId, jpeg, 'photo')).toMatchObject({
      status: 400,
      body: { error: 'unsupported_type' },
    });
    const script = Buffer.from('<script>alert(1)</script>');
    expect(await upload(c.manager, c.doctorId, script, 'photo.webp')).toMatchObject({
      status: 400,
      body: { error: 'unsupported_type' },
    });
    // A video while videos are Aparat ids (the default).
    const mp4 = Buffer.concat([
      Buffer.from([0, 0, 0, 0x20]),
      Buffer.from('ftypisom'),
      Buffer.alloc(40),
    ]);
    expect(await upload(c.manager, c.doctorId, mp4, 'clip.mp4')).toMatchObject({
      status: 400,
      body: { error: 'video_hosted_on_aparat' },
    });
    expect(await count()).toBe(0);

    // Another center's manager does not see this doctor.
    const stranger = await clinic();
    expect((await upload(stranger.manager, c.doctorId, jpeg, 'photo.jpg')).status).toBe(404);
    expect(await count()).toBe(0);
  });
});

describe('the scanner (ClamAV, rule 28)', () => {
  it('finds the EICAR test file, passes a clean picture, and refuses when unreachable', async () => {
    const real = h.app.get<MalwareScanner>(MALWARE_SCANNER);
    const infected = await real.scan(eicar());
    expect(infected.clean).toBe(false);
    expect(infected.clean ? '' : infected.signature).toMatch(/eicar/i);
    expect(await real.scan(await photo())).toEqual({ clean: true });
    const away = new ClamdScanner('127.0.0.1', 1, 2_000);
    await expect(away.scan(Buffer.from('x'))).rejects.toMatchObject({
      response: { error: 'scanner_unavailable' },
    });
  });
});

describe('media: private until a published version shows it', () => {
  it('scans, strips and converts in the worker; public only after approval; withdrawn after', async () => {
    const c = await clinic();
    const address = slug('dr-media');
    await staff(specialist, 'POST', `/catalog/doctors/${c.doctorId}/profile`, {
      slug: address,
      ...reason,
    });
    const up = await upload(c.manager, c.doctorId, await photo(), 'photo.JPG');
    expect(up.status).toBe(201);
    expect(up.body).toMatchObject({ kind: 'image', status: 'pending', mime: 'image/jpeg' });
    const assetId = up.body['id'] as string;

    // Approving before the file is processed is refused.
    await staff(c.manager, 'PUT', `/catalog/doctors/${c.doctorId}/profile/draft`, {
      photoAssetId: assetId,
      ...reason,
    });
    const submitted = await staff(
      c.manager,
      'POST',
      `/catalog/doctors/${c.doctorId}/profile/submit`,
      reason,
    );
    const early = await staff(
      specialist,
      'POST',
      `/catalog/profile-versions/${submitted.body['id'] as string}/approve`,
      reason,
    );
    expect(early).toMatchObject({ status: 409, body: { error: 'media_not_ready' } });

    expect(await worker.run()).toMatchObject({ ready: 1, rejected: 0, madePublic: 0 });
    const media = await staff(c.manager, 'GET', `/catalog/media/${assetId}`);
    expect(media.body).toMatchObject({ status: 'ready' });
    const variants = media.body['variants'] as { mime: string; width: number; url: string }[];
    expect(variants.map((v) => `${String(v.width)} ${v.mime}`)).toEqual([
      '320 image/webp',
      '320 image/avif',
      '640 image/webp',
      '640 image/avif',
    ]);
    // A signed private link works; the variant has no metadata left.
    const signed = await fetch(variants[0]?.url ?? '');
    expect(signed.status).toBe(200);
    // The draft's preview is shown in the panel's page: inline (task 9-3, R12), still uncached.
    expect(signed.headers.get('content-disposition')).toBeNull();
    expect(signed.headers.get('cache-control')).toBe('private, no-store');
    const bytes = Buffer.from(await signed.arrayBuffer());
    expect((await sharp(bytes).metadata()).exif).toBeUndefined();
    // Nothing is in the public space yet.
    const objects = h.app.get<ObjectStorage>(OBJECT_STORAGE);
    const publicUrl = objects.publicUrl(`media/${assetId}/320.webp`);
    expect(await objectStatus(publicUrl)).toBe(404);

    const approved = await staff(
      specialist,
      'POST',
      `/catalog/profile-versions/${submitted.body['id'] as string}/approve`,
      reason,
    );
    expect(approved.status).toBe(201);
    // Published, but its file becomes public only when the worker copies it.
    expect((await publicGet(`/public/doctors/${address}`)).body['photo']).toBeNull();
    expect(await worker.run()).toMatchObject({ madePublic: 1, withdrawn: 0 });
    expect(await objectStatus(publicUrl)).toBe(200);
    const shown = await publicGet(`/public/doctors/${address}`);
    expect(
      (shown.body['photo'] as { variants: { url: string }[] }).variants.map((v) => v.url),
    ).toContain(publicUrl);

    // A new photo is published: the old one leaves the public space; the published version
    // stayed public while the new one was a draft.
    const second = await upload(c.manager, c.doctorId, await photo(700), 'second.jpeg');
    await worker.run();
    await staff(c.manager, 'PUT', `/catalog/doctors/${c.doctorId}/profile/draft`, {
      photoAssetId: second.body['id'],
      ...reason,
    });
    expect((await publicGet(`/public/doctors/${address}`)).status).toBe(200);
    const again = await staff(
      c.manager,
      'POST',
      `/catalog/doctors/${c.doctorId}/profile/submit`,
      reason,
    );
    await staff(
      specialist,
      'POST',
      `/catalog/profile-versions/${again.body['id'] as string}/approve`,
      reason,
    );
    expect(await worker.run()).toMatchObject({ madePublic: 1, withdrawn: 1 });
    expect(await objectStatus(publicUrl)).toBe(404);
    const { rows } = await h.owner.query<Row>(
      'SELECT published_at FROM media_assets WHERE id = $1',
      [assetId],
    );
    expect(rows[0]?.['published_at']).toBeNull();
  });

  it('a file the scanner flags is rejected and never processed or published', async () => {
    const c = await clinic();
    await staff(specialist, 'POST', `/catalog/doctors/${c.doctorId}/profile`, {
      slug: slug('dr-flagged'),
      ...reason,
    });
    const up = await upload(c.manager, c.doctorId, await photo(), 'photo.jpg');
    // The same worker, with a scanner that reports every file (ClamAV finds EICAR only as a
    // whole file, which is no picture, so a real one cannot pass the type check first).
    const flagging = new MediaWorker(
      h.app.get<Database>(DATABASE),
      h.app.get<ConfigPort>(CONFIG),
      h.app.get<ObjectStorage>(OBJECT_STORAGE),
      { configured: true, scan: () => Promise.resolve({ clean: false, signature: 'Test.Flag' }) },
      h.app.get<VideoTranscoder>(VIDEO_TRANSCODER),
    );
    // Any other test's pending file is decided too; this one must be rejected.
    expect((await flagging.run()).rejected).toBeGreaterThanOrEqual(1);
    const media = await staff(c.manager, 'GET', `/catalog/media/${up.body['id'] as string}`);
    expect(media.body).toMatchObject({ status: 'rejected', rejection: 'infected', variants: [] });
    // It cannot be put on a profile.
    const draft = await staff(c.manager, 'PUT', `/catalog/doctors/${c.doctorId}/profile/draft`, {
      photoAssetId: up.body['id'],
      ...reason,
    });
    expect(draft).toMatchObject({ status: 400, body: { error: 'media_not_usable' } });
    // Decided files never change (the database refuses it).
    await expect(
      h.owner.query(`UPDATE media_assets SET status = 'ready', variants = '[]' WHERE id = $1`, [
        up.body['id'],
      ]),
    ).rejects.toThrow();
  });
});

describe('versions (rule 8) and the Aparat video', () => {
  it('editing a published profile opens a new draft; the published one stays public', async () => {
    const c = await clinic();
    const address = slug('dr-versions');
    await staff(specialist, 'POST', `/catalog/doctors/${c.doctorId}/profile`, {
      slug: address,
      ...reason,
    });
    expect(
      (
        await publish(c, {
          biography: 'نسخه اول',
          video: { hosting: 'aparat', aparatId: 'abc123' },
        })
      ).status,
    ).toBe(201);
    await staff(c.manager, 'PUT', `/catalog/doctors/${c.doctorId}/profile/draft`, {
      biography: 'نسخه دوم',
      ...reason,
    });
    const shown = await publicGet(`/public/doctors/${address}`);
    expect(shown.body).toMatchObject({
      biography: 'نسخه اول',
      video: { hosting: 'aparat', aparatId: 'abc123' },
    });
    const own = await staff(c.manager, 'GET', `/catalog/doctors/${c.doctorId}/profile`);
    expect(own.body).toMatchObject({
      published: { versionNo: 1, status: 'published' },
      open: { versionNo: 2, status: 'draft', content: { biography: 'نسخه دوم' } },
    });
    // A self-hosted video while videos are Aparat ids is refused.
    const self = await staff(c.manager, 'PUT', `/catalog/doctors/${c.doctorId}/profile/draft`, {
      video: { hosting: 'self', assetId: '01a0f116-ecc6-73a0-93f5-63ded6e6242f' },
      ...reason,
    });
    expect(self).toMatchObject({ status: 400, body: { error: 'video_hosting_mismatch' } });
    // The database refuses to change a published version or move it back.
    const published = (own.body['published'] as { id: string }).id;
    await expect(
      h.owner.query(`UPDATE doctor_profile_versions SET content = '{}' WHERE id = $1`, [published]),
    ).rejects.toThrow();
    await expect(
      h.owner.query(`UPDATE doctor_profile_versions SET status = 'draft' WHERE id = $1`, [
        published,
      ]),
    ).rejects.toThrow();
  });

  it('the review queue lists what waits, for the network of the doctor’s city only', async () => {
    const c = await clinic();
    await staff(specialist, 'POST', `/catalog/doctors/${c.doctorId}/profile`, {
      slug: slug('dr-queue'),
      ...reason,
    });
    await staff(c.manager, 'PUT', `/catalog/doctors/${c.doctorId}/profile/draft`, {
      biography: 'صف',
      ...reason,
    });
    await staff(c.manager, 'POST', `/catalog/doctors/${c.doctorId}/profile/submit`, reason);
    const queue = await staff(specialist, 'GET', '/catalog/profile-reviews');
    expect(queue.status).toBe(200);
    expect(
      (queue.body as unknown as { doctor: { id: string } }[]).some(
        (v) => v.doctor.id === c.doctorId,
      ),
    ).toBe(true);
    const elsewhere = await loggedInAccount(h, 'staff');
    await grantRole(h, elsewhere.id, 'network_specialist', { kind: 'city', code: 'shiraz' });
    const theirs = await staff(elsewhere, 'GET', '/catalog/profile-reviews');
    expect(
      (theirs.body as unknown as { doctor: { id: string } }[]).some(
        (v) => v.doctor.id === c.doctorId,
      ),
    ).toBe(false);
  });
});

describe('task 8-3: the sitemap’s profiles and the link list', () => {
  it('indexable only when published with a listed workplace; the link list has them all', async () => {
    const c = await clinic();
    const address = slug('dr-sitemap');
    const made = await staff(specialist, 'POST', `/catalog/doctors/${c.doctorId}/profile`, {
      slug: address,
      ...reason,
    });
    expect(made.status).toBe(201);
    expect((await publish(c, { biography: 'بیوگرافی' })).status).toBe(201);

    // Published with a listed workplace: indexable, in the sitemap and the link list.
    const sitemap = async () =>
      (await publicGet('/public/doctors')).body as unknown as { slug: string }[];
    expect((await publicGet(`/public/doctors/${address}`)).body['indexable']).toBe(true);
    expect((await sitemap()).find((l) => l.slug === address)).toMatchObject({
      indexable: true,
      name: 'دکتر نگار زرین‌مکان',
      lastModified: expect.any(String) as unknown,
    });

    // Its only workplace removed: the page still shows, not indexable, out of the sitemap,
    // still in the link list with the flag.
    await h.owner.query('UPDATE doctor_workplaces SET deleted_at = now() WHERE doctor_id = $1', [
      c.doctorId,
    ]);
    const shown = await publicGet(`/public/doctors/${address}`);
    expect(shown.status).toBe(200);
    expect(shown.body['indexable']).toBe(false);
    expect((await sitemap()).map((l) => l.slug)).not.toContain(address);
    const links = await staff(specialist, 'GET', '/catalog/profile-links');
    expect(links.status).toBe(200);
    expect(links.body as unknown as Body[]).toContainEqual({
      slug: address,
      name: 'دکتر نگار زرین‌مکان',
      indexable: false,
      lastModified: expect.any(String) as unknown,
    });
    // Never an unpublished one, and nothing but names and addresses.
    for (const l of await sitemap()) {
      expect(Object.keys(l).sort()).toEqual(['indexable', 'lastModified', 'name', 'slug']);
    }
    expect((await staff(c.manager, 'GET', '/catalog/profile-links')).status).toBe(403);
  });
});
