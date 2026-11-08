/**
 * What every part of the demo seed shares: the people (staff signed in again whenever a token
 * ran out on the moving clock), the patients, and a few readers. Every write goes through the
 * API (docs/decisions/demo-mode-decisions.md); nothing here writes to the database.
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { inflateRawSync } from 'node:zlib';
import { call } from '../../seed.ts';
import { codeFor } from '../../seed-funded.ts';
import { freshCode } from '../../totp.ts';
import { secrets, STATE_DIR, URLS } from '../runtime.ts';

export type Body = Record<string, unknown>;

/** The demo password of every staff and center account, from the ignored secrets file. */
export const demoPassword = () => secrets().staffPassword;

export interface Person {
  key: string;
  username: string;
  /** The made-up Persian name shown in the accounts sheet (the panel shows the username). */
  name: string;
  kind: 'staff' | 'center';
  roles: string[];
  accountId: string;
  totpSecret: string;
  lastStep: number;
  token?: string;
}

export interface Patient {
  mobile: string;
  name: string;
  nationalId: string;
  city: string;
  female: boolean;
  token?: string;
  /** The mobile client's refresh token: a new access token without a new SMS code. */
  refresh?: string;
  lastCode: string;
  story?: string;
}

export interface SeedState {
  phases: string[];
  people: Record<string, Person>;
  patients: Patient[];
  /** Anything a later phase needs from an earlier one (ids, codes). */
  data: Record<string, unknown>;
}

/** A person of the seed by key; a missing one is the seed's own error, said plainly. */
export function person(state: SeedState, key: string): Person {
  const who = state.people[key];
  if (!who) throw new Error(`the seed has no person ${key}`);
  return who;
}

export function patientAt(state: SeedState, index: number): Patient {
  const who = state.patients[index];
  if (!who) throw new Error(`the seed has no patient ${String(index)}`);
  return who;
}

const STATE_FILE = () => resolve(STATE_DIR, 'seed-state.json');

export function loadState(): SeedState {
  if (!existsSync(STATE_FILE())) return { phases: [], people: {}, patients: [], data: {} };
  return JSON.parse(readFileSync(STATE_FILE(), 'utf8')) as SeedState;
}

export function saveState(state: SeedState) {
  const plain = {
    ...state,
    people: Object.fromEntries(
      Object.entries(state.people).map(([k, p]) => [k, { ...p, token: undefined }]),
    ),
    patients: state.patients.map((p) => ({ ...p, token: undefined })),
  };
  writeFileSync(STATE_FILE(), JSON.stringify(plain, null, 2));
}

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function signIn(p: Person) {
  const login = await call('POST', '/auth/staff/login', undefined, {
    username: p.username,
    password: demoPassword(),
    client: 'mobile',
  });
  const { step, code } = freshCode(p.totpSecret, p.lastStep);
  p.lastStep = step;
  const done = await call('POST', '/auth/totp/verify', String(login['accessToken']), { code });
  p.token = String(done['accessToken']);
}

/** One API call as a staff member, signed in again once if their token has run out. */
export async function as(p: Person, method: string, path: string, body?: unknown): Promise<Body> {
  if (!p.token) await signIn(p);
  try {
    return await call(method, path, p.token, body);
  } catch (error) {
    if (!(error instanceof Error) || !/→ 401 /.test(error.message)) throw error;
    await signIn(p);
    return call(method, path, p.token, body);
  }
}

/** The newest code the worker printed for this mobile after the last one used. */
export async function nextCode(p: Patient) {
  const code = await codeFor(p.mobile, p.lastCode);
  p.lastCode = code;
  return code;
}

export async function patientSignIn(p: Patient, fixedCode: string) {
  // The server's resend wait (a code an hour per mobile, one each minute) is waited out.
  for (let attempt = 0; ; attempt++) {
    try {
      await call('POST', '/auth/otp/request', undefined, { mobile: `0${p.mobile}` });
      break;
    } catch (error) {
      const wait = /resend_too_soon","retryAfterSeconds":(\d+)/.exec(
        error instanceof Error ? error.message : '',
      );
      if (!wait || attempt > 2) throw error;
      await sleep((Number(wait[1]) + 1) * 1000);
    }
  }
  // The fixed staging code, once the worker printed it: the last code seen is then this one, so
  // the next code asked (a consent, an acceptance) is told apart from it.
  const masked = `${p.mobile.slice(0, 3)}***${p.mobile.slice(-4)}`;
  for (let i = 0; i < 60; i++) {
    try {
      const codes = JSON.parse(readFileSync(resolve(STATE_DIR, 'otp.json'), 'utf8')) as Record<
        string,
        string
      >;
      if (codes[masked] === fixedCode) break;
    } catch {
      // not written yet
    }
    await sleep(500);
  }
  p.lastCode = fixedCode;
  const done = await call('POST', '/auth/otp/verify', undefined, {
    mobile: `0${p.mobile}`,
    code: fixedCode,
    client: 'mobile',
  });
  p.token = String(done['accessToken']);
  p.refresh = String(done['refreshToken']);
}

/** One API call as a patient, signed in again once if the token has run out. */
export async function asPatient(
  p: Patient,
  fixedCode: string,
  method: string,
  path: string,
  body?: unknown,
): Promise<Body> {
  if (!p.token) await patientSignIn(p, fixedCode);
  try {
    return await call(method, path, p.token, body);
  } catch (error) {
    if (!(error instanceof Error) || !/→ 401 /.test(error.message)) throw error;
    await renewPatient(p, fixedCode);
    return call(method, path, p.token, body);
  }
}

/** The app's way: the refresh token first (rotated), a new code only if that is refused. */
async function renewPatient(p: Patient, fixedCode: string) {
  const renewed = p.refresh
    ? await call('POST', '/auth/refresh', undefined, { refreshToken: p.refresh }).catch(() => null)
    : null;
  if (renewed) {
    p.token = String(renewed['accessToken']);
    p.refresh = String(renewed['refreshToken']);
  } else await patientSignIn(p, fixedCode);
}

const PDF = Buffer.from('%PDF-1.4\n1 0 obj << >> endobj\ntrailer << >>\n%%EOF\n');

/** A small PDF uploaded as a form, the way the browser sends a document. */
export async function upload(path: string, token: string, fields: Record<string, string>) {
  const form = new FormData();
  for (const [k, v] of Object.entries(fields)) form.append(k, v);
  form.append('file', new Blob([new Uint8Array(PDF)]), 'document.pdf');
  const res = await fetch(`${URLS.api}/api/v1${path}`, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}` },
    body: form,
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`POST ${path} → ${String(res.status)} ${text}`);
  return JSON.parse(text) as Body;
}

/** A document a patient sends, signed in again once if the token has run out. */
export async function patientUpload(
  p: Patient,
  fixedCode: string,
  path: string,
  fields: Record<string, string>,
) {
  if (!p.token) await patientSignIn(p, fixedCode);
  try {
    return await upload(path, p.token ?? '', fields);
  } catch (error) {
    if (!(error instanceof Error) || !/→ 401 /.test(error.message)) throw error;
    await renewPatient(p, fixedCode);
    return upload(path, p.token ?? '', fields);
  }
}

// --- the doctors' workbook ---------------------------------------------------------------

/** The rows of the first sheet of an .xlsx, as text (a zip read with zlib; no dependency). */
export function readXlsx(file: string): string[][] {
  const zip = readFileSync(file);
  const entries = new Map<string, Buffer>();
  let end = zip.length - 22;
  while (end >= 0 && zip.readUInt32LE(end) !== 0x06054b50) end--;
  const count = zip.readUInt16LE(end + 10);
  let at = zip.readUInt32LE(end + 16);
  for (let i = 0; i < count; i++) {
    const method = zip.readUInt16LE(at + 10);
    const size = zip.readUInt32LE(at + 20);
    const nameLength = zip.readUInt16LE(at + 28);
    const extra = zip.readUInt16LE(at + 30);
    const comment = zip.readUInt16LE(at + 32);
    const local = zip.readUInt32LE(at + 42);
    const name = zip.toString('utf8', at + 46, at + 46 + nameLength);
    const dataAt = local + 30 + zip.readUInt16LE(local + 26) + zip.readUInt16LE(local + 28);
    const raw = zip.subarray(dataAt, dataAt + size);
    entries.set(name, method === 8 ? inflateRawSync(raw) : raw);
    at += 46 + nameLength + extra + comment;
  }
  const xml = (name: string) => entries.get(name)?.toString('utf8') ?? '';
  const unescape = (s: string) =>
    s
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"')
      .replace(/&apos;/g, "'")
      .replace(/&amp;/g, '&');
  const shared = [...xml('xl/sharedStrings.xml').matchAll(/<si>([\s\S]*?)<\/si>/g)].map((m) =>
    unescape(
      [...(m[1] ?? '').matchAll(/<t[^>]*>([\s\S]*?)<\/t>/g)].map((t) => t[1] ?? '').join(''),
    ),
  );
  const sheet = xml('xl/worksheets/sheet1.xml');
  const rows: string[][] = [];
  for (const row of sheet.matchAll(/<row[^>]*>([\s\S]*?)<\/row>/g)) {
    const cells: string[] = [];
    for (const c of (row[1] ?? '').matchAll(
      /<c r="([A-Z]+)\d+"([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g,
    )) {
      const col = (c[1] ?? 'A').split('').reduce((n, ch) => n * 26 + ch.charCodeAt(0) - 64, 0) - 1;
      const attrs = c[2] ?? '';
      const inner = c[3] ?? '';
      let value = /<v>([\s\S]*?)<\/v>/.exec(inner)?.[1] ?? '';
      if (/t="s"/.test(attrs)) value = shared[Number(value)] ?? '';
      else if (/t="inlineStr"/.test(attrs))
        value = /<t[^>]*>([\s\S]*?)<\/t>/.exec(inner)?.[1] ?? '';
      cells[col] = unescape(value).trim();
    }
    rows.push(Array.from(cells, (v: string | undefined) => v ?? ''));
  }
  return rows;
}
