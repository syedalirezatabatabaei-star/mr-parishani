'use client';

import { unwrap } from '@sepehr/api-client';
import type { ContentBlock, ContentSlug } from '@sepehr/contracts';
import { buttonClass, Notice, useApi } from '@sepehr/ui';
import { useState } from 'react';
import { useRun } from '../../content-forms';

type Kind = ContentBlock['kind'];
const KIND_NAME: Readonly<Record<Kind, string>> = {
  heading: 'تیتر',
  paragraph: 'پاراگراف',
  list: 'فهرست',
  link: 'لینک',
};

const empty = (kind: Kind): ContentBlock =>
  kind === 'list'
    ? { kind, items: [''] }
    : kind === 'link'
      ? { kind, text: '', href: '/' }
      : { kind, text: '' };

/** One block as the public page draws it (the same as apps/web's page). */
export function BlockPreview({ block }: { block: ContentBlock }) {
  switch (block.kind) {
    case 'heading':
      return <h3 className="pt-2 text-[length:var(--text-lg)] font-bold">{block.text}</h3>;
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
          <span className="font-medium text-accent underline underline-offset-4">{block.text}</span>{' '}
          <bdi dir="ltr" className="text-[length:var(--text-xs)] text-ink-subtle">
            {block.href}
          </bdi>
        </p>
      );
  }
}

/**
 * The simple editor of a text page (owner 1405/08/10): headings, paragraphs, lists and links,
 * moved and removed; a preview beside; the result proposed as a new version for a second
 * person. The final legal text is the lawyer's.
 */
export function PageEditor({
  slug,
  title: startTitle,
  blocks: startBlocks,
}: {
  slug: ContentSlug;
  title: string;
  blocks: readonly ContentBlock[];
}) {
  const api = useApi();
  const { error, setError, busy, run } = useRun();
  const [title, setTitle] = useState(startTitle);
  const [blocks, setBlocks] = useState<ContentBlock[]>([...startBlocks]);
  const [reason, setReason] = useState('');
  const [done, setDone] = useState(false);

  const set = (i: number, block: ContentBlock) => {
    setBlocks((all) => all.map((b, j) => (j === i ? block : b)));
  };
  const move = (i: number, by: -1 | 1) => {
    setBlocks((all) => {
      const next = [...all];
      const [b] = next.splice(i, 1);
      if (b) next.splice(i + by, 0, b);
      return next;
    });
  };
  const submit = () => {
    if (reason.trim().length < 3) {
      setError('دلیل تغییر را بنویسید.');
      return;
    }
    setDone(false);
    void run(() =>
      unwrap(
        api.POST('/api/v1/config/content/pages/{slug}', {
          params: { path: { slug } },
          body: {
            title,
            blocks: blocks.map((b) =>
              b.kind === 'list' ? { ...b, items: b.items.filter((x) => x.trim()) } : b,
            ),
            reason,
          },
        }),
      ),
    ).then((ok) => {
      if (ok) setDone(true);
    });
  };

  return (
    <div className="grid gap-6 lg:grid-cols-2">
      <section aria-label="ویرایشگر" className="space-y-3">
        <BlockInput id="page-title" label="عنوان صفحه" value={title} onChange={setTitle} />
        <ol className="space-y-3" aria-label="بلوک‌های صفحه">
          {blocks.map((b, i) => (
            <li key={i} className="space-y-2 rounded-md border border-border bg-surface p-3">
              <div className="flex flex-wrap items-center gap-2">
                <span className="text-[length:var(--text-sm)] font-bold">{KIND_NAME[b.kind]}</span>
                <span className="flex-1" />
                <button
                  type="button"
                  aria-label={`بالا بردن بلوک ${String(i + 1)}`}
                  disabled={i === 0}
                  className={buttonClass('quiet')}
                  onClick={() => {
                    move(i, -1);
                  }}
                >
                  ↑
                </button>
                <button
                  type="button"
                  aria-label={`پایین بردن بلوک ${String(i + 1)}`}
                  disabled={i === blocks.length - 1}
                  className={buttonClass('quiet')}
                  onClick={() => {
                    move(i, 1);
                  }}
                >
                  ↓
                </button>
                <button
                  type="button"
                  aria-label={`حذف بلوک ${String(i + 1)}`}
                  className={buttonClass('quiet')}
                  onClick={() => {
                    setBlocks((all) => all.filter((_, j) => j !== i));
                  }}
                >
                  حذف
                </button>
              </div>
              {b.kind === 'heading' && (
                <BlockInput
                  id={`b${String(i)}`}
                  label="متن تیتر"
                  value={b.text}
                  onChange={(text) => {
                    set(i, { ...b, text });
                  }}
                />
              )}
              {b.kind === 'paragraph' && (
                <BlockArea
                  id={`b${String(i)}`}
                  label="متن پاراگراف"
                  value={b.text}
                  onChange={(text) => {
                    set(i, { ...b, text });
                  }}
                />
              )}
              {b.kind === 'list' && (
                <BlockArea
                  id={`b${String(i)}`}
                  label="بندهای فهرست (هر خط یک بند)"
                  value={b.items.join('\n')}
                  onChange={(text) => {
                    set(i, { ...b, items: text.split('\n') });
                  }}
                />
              )}
              {b.kind === 'link' && (
                <div className="grid gap-2 sm:grid-cols-2">
                  <BlockInput
                    id={`b${String(i)}t`}
                    label="متن لینک"
                    value={b.text}
                    onChange={(text) => {
                      set(i, { ...b, text });
                    }}
                  />
                  <BlockInput
                    id={`b${String(i)}h`}
                    label="مسیر (/…، tel: یا mailto:)"
                    value={b.href}
                    ltr
                    onChange={(href) => {
                      set(i, { ...b, href });
                    }}
                  />
                </div>
              )}
            </li>
          ))}
        </ol>
        <div className="flex flex-wrap gap-2" aria-label="افزودن بلوک">
          {(Object.keys(KIND_NAME) as Kind[]).map((k) => (
            <button
              key={k}
              type="button"
              className={buttonClass('secondary')}
              onClick={() => {
                setBlocks((all) => [...all, empty(k)]);
              }}
            >
              افزودن {KIND_NAME[k]}
            </button>
          ))}
        </div>
        <BlockInput id="reason" label="دلیل تغییر" value={reason} onChange={setReason} />
        {error && <Notice tone="danger">{error}</Notice>}
        {done && <Notice tone="success">پیشنهاد ثبت شد؛ منتظر تأیید نفر دوم.</Notice>}
        <button type="button" disabled={busy} className={buttonClass('primary')} onClick={submit}>
          پیشنهاد نسخه تازه
        </button>
      </section>
      <section
        aria-label="پیش‌نمایش"
        className="space-y-3 self-start rounded-lg border border-dashed border-border-strong bg-canvas p-5"
      >
        <p className="text-[length:var(--text-xs)] font-bold text-ink-subtle">پیش‌نمایش</p>
        <h2 className="text-[length:var(--text-xl)] font-extrabold">{title}</h2>
        {blocks.map((b, i) => (
          <BlockPreview key={i} block={b} />
        ))}
      </section>
    </div>
  );
}

function BlockInput({
  id,
  label,
  value,
  ltr,
  onChange,
}: {
  id: string;
  label: string;
  value: string;
  ltr?: boolean;
  onChange: (v: string) => void;
}) {
  return (
    <div className="space-y-1">
      <label htmlFor={id} className="block text-[length:var(--text-sm)] font-medium">
        {label}
      </label>
      <input
        id={id}
        value={value}
        dir={ltr ? 'ltr' : undefined}
        onChange={(e) => {
          onChange(e.target.value);
        }}
        className="min-h-11 w-full rounded-md border border-border-strong bg-surface px-3"
      />
    </div>
  );
}

function BlockArea({
  id,
  label,
  value,
  onChange,
}: {
  id: string;
  label: string;
  value: string;
  onChange: (v: string) => void;
}) {
  return (
    <div className="space-y-1">
      <label htmlFor={id} className="block text-[length:var(--text-sm)] font-medium">
        {label}
      </label>
      <textarea
        id={id}
        value={value}
        rows={4}
        onChange={(e) => {
          onChange(e.target.value);
        }}
        className="w-full rounded-md border border-border-strong bg-surface p-3"
      />
    </div>
  );
}
