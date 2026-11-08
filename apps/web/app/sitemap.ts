import { unwrap } from '@sepehr/api-client';
import type { MetadataRoute } from 'next';
import { publicOrigin } from '../lib/origin';
import { serverApi } from '../lib/server-api';

/**
 * The sitemap (task 8-3): the indexable doctors' pages only (published, with a listed
 * workplace) and the search page; nothing behind a sign-in. Built on each request, so a
 * profile published or unlisted shows at once.
 */
export const dynamic = 'force-dynamic';

export default async function sitemap(): Promise<MetadataRoute.Sitemap> {
  const origin = publicOrigin();
  const api = await serverApi();
  const profiles = await unwrap(api.GET('/api/v1/public/doctors'));
  return [
    { url: `${origin}/search`, changeFrequency: 'daily' },
    ...profiles.map((p) => ({
      url: `${origin}/doctors/${p.slug}`,
      ...(p.lastModified ? { lastModified: p.lastModified } : {}),
      changeFrequency: 'weekly' as const,
    })),
  ];
}
