'use client';

import { buttonClass } from '@sepehr/ui';

/** Excel reads UTF-8 only after a byte order mark. */
const BOM = String.fromCharCode(0xfeff);

/** A CSV cell: quoted, its quotes doubled; a leading = + - @ neutralized (formula injection). */
const cell = (value: string) => {
  const safe = /^[=+\-@]/.test(value) ? `'${value}` : value;
  return `"${safe.replace(/"/g, '""')}"`;
};

/**
 * The link list as a CSV for the WordPress site's editors (task 8-3): UTF-8 with a BOM, so
 * Persian Excel opens it right (doc 17 §5); made in the browser from what the page shows.
 */
export function CsvButton({
  rows,
}: {
  rows: readonly { name: string; url: string; indexable: boolean }[];
}) {
  const download = () => {
    const lines = [
      ['نام پزشک', 'نشانی', 'قابل نمایه در موتور جست‌وجو'].map(cell).join(','),
      ...rows.map((r) => [r.name, r.url, r.indexable ? 'بله' : 'خیر'].map(cell).join(',')),
    ];
    const blob = new Blob([`${BOM}${lines.join('\r\n')}\r\n`], {
      type: 'text/csv;charset=utf-8',
    });
    const link = document.createElement('a');
    link.href = URL.createObjectURL(blob);
    link.download = 'sepehr-doctor-profiles.csv';
    link.click();
    URL.revokeObjectURL(link.href);
  };
  return (
    <button type="button" className={buttonClass('primary')} onClick={download}>
      دریافت CSV
    </button>
  );
}
