import type { PublicProfile } from '@sepehr/contracts';
import { describe, expect, it } from 'vitest';
import {
  profileStructuredData,
  serializeStructuredData,
  structuredDataProblems,
} from './structured-data';

const profile: PublicProfile = {
  slug: 'dr-negar-zarrinmakan',
  doctor: { id: '01990000-0000-7000-8000-000000000001', name: 'دکتر نگار زرین‌مکان' },
  medicalCouncilNumber: '123456',
  treatmentFields: [{ code: 'dental', name: 'دندانپزشکی' }],
  specialtyTitle: 'متخصص ارتودنسی',
  biography: null,
  history: [],
  socials: [
    { kind: 'instagram', url: 'https://instagram.com/dr.zarrin' },
    { kind: 'website', url: 'not-a-url' },
  ],
  photo: null,
  video: null,
  workplaces: [
    {
      workplaceId: '01990000-0000-7000-8000-000000000002',
      placeName: 'کلینیک لبخند',
      branchName: null,
      address: 'خیابان ولیعصر، پلاک ۱۰',
      cityCode: 'tehran',
      services: [],
    },
  ],
  withSepehrSince: null,
  publishedAt: null,
  indexable: true,
};

const city = () => 'تهران';

describe('the profile’s structured data (task 8-3)', () => {
  it('is valid by the local validator: Physician with address and sameAs, and its clinic', () => {
    const data = profileStructuredData(
      profile,
      'https://app.sepehr.example/doctors/dr-negar-zarrinmakan',
      'دندانپزشکی',
      city,
    );
    expect(structuredDataProblems(data)).toEqual([]);
    const [physician, clinic] = data['@graph'] as Record<string, unknown>[];
    expect(physician).toMatchObject({
      '@type': 'Physician',
      address: { '@type': 'PostalAddress', addressLocality: 'تهران', addressCountry: 'IR' },
      // Only absolute addresses; a typed «not-a-url» is left out.
      sameAs: ['https://instagram.com/dr.zarrin'],
    });
    expect(clinic).toMatchObject({ '@type': 'MedicalClinic', name: 'کلینیک لبخند' });
  });

  it('escapes «<» so no text can close the script', () => {
    const text = serializeStructuredData({ name: '</script><b>' });
    expect(text).not.toContain('<');
  });
});

describe('the local validator', () => {
  it('names what a strict reader would object to', () => {
    expect(structuredDataProblems({ '@context': 'http://schema.org', '@graph': [] })).toEqual([
      '@context',
      '@graph',
    ]);
    const problems = structuredDataProblems({
      '@context': 'https://schema.org',
      '@graph': [
        { '@type': 'Physician', name: 'x', url: '/doctors/x', identifier: { '@type': 'Thing' } },
        { '@type': 'MedicalClinic', name: '', address: { '@type': 'PostalAddress' } },
      ],
    });
    expect(problems).toEqual(
      expect.arrayContaining([
        '@graph[0].url: not an absolute URL',
        '@graph[0].identifier: @type Thing',
        '@graph[1].name: missing',
        '@graph[1].address.streetAddress: missing',
        '@graph[1].address.addressCountry: missing',
      ]),
    );
  });
});
