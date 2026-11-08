import { unwrap } from '@sepehr/api-client';
import { CONTENT_SLUGS, type ContentBlock, type PublicPage } from '@sepehr/contracts';
import { showInstantDay } from '@sepehr/ui';
import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { serverApi } from '../../../../lib/server-api';

type Slug = (typeof CONTENT_SLUGS)[number];
const isSlug = (v: string): v is Slug => (CONTENT_SLUGS as readonly string[]).includes(v);

async function page(slug: string): Promise<PublicPage | null> {
  if (!isSlug(slug)) return null;
  try {
    return await unwrap(
      (await serverApi()).GET('/api/v1/config/pages/{slug}', { params: { path: { slug } } }),
    );
  } catch {
    return null;
  }
}

export async function generateMetadata({
  params,
}: {
  params: Promise<{ slug: string }>;
}): Promise<Metadata> {
  const found = await page((await params).slug);
  return { title: found ? `${found.title} | سپهر سلامتی` : 'سپهر سلامتی' };
}

/** One block of the simple editor: a heading, a paragraph, a list or a link. */
function Block({ block }: { block: ContentBlock }) {
  switch (block.kind) {
    case 'heading':
      return <h2 className="pt-2 text-[length:var(--text-lg)] font-bold">{block.text}</h2>;
    case 'paragraph':
      return <p className="leading-relaxed whitespace-pre-line">{block.text}</p>;
    case 'list':
      return (
        <ul className="list-disc space-y-1 ps-6">
          {block.items.map((item, i) => (
            <li key={i}>{item}</li>
          ))}
        </ul>
      );
    case 'link':
      return (
        <p>
          <a href={block.href} className="font-medium text-accent underline underline-offset-4">
            {block.text}
          </a>
        </p>
      );
  }
}

/**
 * The text pages (owner 1405/08/10): about, terms, privacy, contact, help and the FAQ, each the
 * version the internal panel approved by two people. 404 until one is approved.
 */
export default async function ContentPage({ params }: { params: Promise<{ slug: string }> }) {
  const found = await page((await params).slug);
  if (!found) notFound();
  return (
    <article className="mx-auto max-w-3xl space-y-4 rounded-lg border border-border bg-surface p-6 sm:p-8">
      <h1 className="text-[length:var(--text-2xl)] font-extrabold">{found.title}</h1>
      <p className="figures text-[length:var(--text-xs)] text-ink-subtle">
        به‌روز: {showInstantDay(found.updatedAt)}
      </p>
      {found.blocks.map((block, i) => (
        <Block key={i} block={block} />
      ))}
    </article>
  );
}
