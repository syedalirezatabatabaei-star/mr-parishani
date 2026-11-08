import type { PublicProfile } from '@sepehr/contracts';

/**
 * A doctor's schema.org data (doc 08 §10; task 8-3): `Physician` and each `MedicalClinic`
 * they work at, and a local validator (no outside service, rules 17–18) the tests run on
 * every page's data.
 */

type Node = Record<string, unknown>;

const absolute = (url: string) => /^https?:\/\/[^\s/]+/.test(url);

export function profileStructuredData(
  p: PublicProfile,
  url: string,
  description: string,
  cityName: (code: string) => string,
): Node {
  const postal = (w: PublicProfile['workplaces'][number]) =>
    w.address
      ? {
          '@type': 'PostalAddress',
          streetAddress: w.address,
          addressLocality: cityName(w.cityCode),
          addressCountry: 'IR',
        }
      : null;
  const clinics = p.workplaces
    .filter((w) => w.placeName)
    .map((w) => {
      const address = postal(w);
      return { '@type': 'MedicalClinic', name: w.placeName, ...(address ? { address } : {}) };
    });
  const image = p.photo?.variants.at(-1)?.url;
  const sameAs = p.socials.map((s) => s.url).filter(absolute);
  const firstAddress = p.workplaces.map(postal).find((a) => a !== null) ?? null;
  const physician = {
    '@type': 'Physician',
    name: p.doctor.name,
    url,
    description,
    identifier: {
      '@type': 'PropertyValue',
      name: 'شماره نظام پزشکی',
      value: p.medicalCouncilNumber,
    },
    ...(image ? { image } : {}),
    ...(p.treatmentFields.length > 0 ? { knowsAbout: p.treatmentFields.map((f) => f.name) } : {}),
    ...(firstAddress ? { address: firstAddress } : {}),
    ...(sameAs.length > 0 ? { sameAs } : {}),
    ...(clinics.length > 0 ? { workLocation: clinics } : {}),
  };
  return { '@context': 'https://schema.org', '@graph': [physician, ...clinics] };
}

/** The data as a script's text: `<` escaped so no text can close the script. */
export const serializeStructuredData = (data: Node): string =>
  JSON.stringify(data).replace(/</g, '\\u003c');

const KNOWN = new Set(['Physician', 'MedicalClinic', 'PostalAddress', 'PropertyValue']);
const REQUIRED: Readonly<Record<string, readonly string[]>> = {
  Physician: ['name', 'url', 'identifier'],
  MedicalClinic: ['name'],
  PostalAddress: ['streetAddress', 'addressCountry'],
  PropertyValue: ['name', 'value'],
};
const URL_KEYS = new Set(['url', 'image']);

/**
 * What a strict reader would object to: a missing context, an unknown or untyped node, a
 * required property missing or empty, a relative or malformed URL, a value that is not
 * JSON (undefined), a country not in ISO 3166 two letters. Empty: valid.
 */
export function structuredDataProblems(data: unknown): string[] {
  const problems: string[] = [];
  if (typeof data !== 'object' || data === null) return ['not an object'];
  const root = data as Node;
  if (root['@context'] !== 'https://schema.org') problems.push('@context');
  const graph = root['@graph'];
  if (!Array.isArray(graph) || graph.length === 0) return [...problems, '@graph'];

  const visit = (value: unknown, path: string): void => {
    if (value === undefined) {
      problems.push(`${path}: undefined`);
      return;
    }
    if (Array.isArray(value)) {
      value.forEach((v, i) => {
        visit(v, `${path}[${String(i)}]`);
      });
      return;
    }
    if (typeof value !== 'object' || value === null) return;
    const node = value as Node;
    const type = node['@type'];
    if (typeof type !== 'string' || !KNOWN.has(type)) {
      problems.push(`${path}: @type ${String(type)}`);
      return;
    }
    for (const key of REQUIRED[type] ?? []) {
      const v = node[key];
      if (v === undefined || v === null || (typeof v === 'string' && v.trim() === '')) {
        problems.push(`${path}.${key}: missing`);
      }
    }
    for (const [key, v] of Object.entries(node)) {
      if (URL_KEYS.has(key) && (typeof v !== 'string' || !absolute(v))) {
        problems.push(`${path}.${key}: not an absolute URL`);
      }
      if (key === 'sameAs') {
        if (!Array.isArray(v) || v.some((u) => typeof u !== 'string' || !absolute(u))) {
          problems.push(`${path}.sameAs: not absolute URLs`);
        }
      }
      if (key === 'addressCountry' && (typeof v !== 'string' || !/^[A-Z]{2}$/.test(v))) {
        problems.push(`${path}.addressCountry: not ISO 3166`);
      }
      if (key !== '@type' && typeof v === 'object') visit(v, `${path}.${key}`);
      if (v === undefined) problems.push(`${path}.${key}: undefined`);
    }
  };
  graph.forEach((n, i) => {
    visit(n, `@graph[${String(i)}]`);
  });
  if (!graph.some((n) => (n as Node)['@type'] === 'Physician')) problems.push('no Physician');
  return problems;
}
