import type { MetadataRoute } from 'next';
import { publicOrigin } from '../lib/origin';

/**
 * robots.txt (task 8-3): the public pages open to search engines, everything behind a
 * sign-in closed (the patient's own pages, the panel, booking, the API), and the sitemap.
 *
 * Rendered on each request: the origin is the running site's (`PUBLIC_WEB_ORIGIN`), not the
 * build machine's.
 */
export const dynamic = 'force-dynamic';

export default function robots(): MetadataRoute.Robots {
  const origin = publicOrigin();
  return {
    rules: [
      {
        userAgent: '*',
        allow: ['/', '/doctors/', '/search'],
        disallow: ['/me/', '/panel/', '/login', '/book/', '/api/', '/style-guide'],
      },
    ],
    sitemap: `${origin}/sitemap.xml`,
  };
}
