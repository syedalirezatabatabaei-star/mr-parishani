// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import axe from 'axe-core';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { FILE_KINDS, FileDropzone, fileProblem, fileSize } from './file-dropzone.js';

afterEach(cleanup);
beforeAll(() => {
  URL.createObjectURL = () => 'blob:preview';
  URL.revokeObjectURL = () => undefined;
});

const KINDS = [FILE_KINDS.jpg, FILE_KINDS.png, FILE_KINDS.pdf];
const MB = 1024 * 1024;

describe('the file box (owner 1405/08/11)', () => {
  it('names sizes and problems in Persian', () => {
    expect(fileSize(800 * 1024)).toBe('۸۰۰ کیلوبایت');
    expect(fileSize(2.4 * MB)).toBe('۲٫۴ مگابایت');
    expect(fileProblem({ name: 'a.zip', type: 'application/zip', size: 10 }, KINDS, MB)).toBe(
      'این نوع فایل پذیرفته نیست؛ فقط JPG، PNG، PDF.',
    );
    expect(fileProblem({ name: 'a.pdf', type: 'application/pdf', size: 2 * MB }, KINDS, MB)).toBe(
      'حجم فایل بیش از ۱ مگابایت است.',
    );
    expect(fileProblem({ name: 'a.PDF', type: '', size: 10 }, KINDS, MB)).toBeNull();
  });

  it('takes a file, shows it, and lets it go; refuses a wrong one in Persian', async () => {
    const user = userEvent.setup({ applyAccept: false });
    const seen: (string | null)[] = [];
    render(
      <form aria-label="فرم">
        <FileDropzone
          id="receipt"
          name="file"
          label="فایل فیش"
          kinds={KINDS}
          maxBytes={5 * MB}
          required
          onFileChange={(f) => seen.push(f?.name ?? null)}
        />
      </form>,
    );
    expect(screen.getByText('الزامی')).toBeTruthy();
    expect(screen.getByText('JPG، PNG، PDF تا ۵ مگابایت')).toBeTruthy();
    const input = screen.getByLabelText(/فایل فیش/);
    expect(document.body.textContent).not.toMatch(/No file chosen|Choose File/);

    await user.upload(input, new File(['%PDF-1.4'], 'fish.pdf', { type: 'application/pdf' }));
    expect(screen.getByText('fish.pdf')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'حذف fish.pdf' })).toBeTruthy();
    expect((input as HTMLInputElement).files?.[0]?.name).toBe('fish.pdf');

    await user.click(screen.getByRole('button', { name: 'حذف fish.pdf' }));
    expect(screen.queryByText('fish.pdf')).toBeNull();

    await user.upload(input, new File(['x'], 'virus.exe', { type: 'application/x-msdownload' }));
    expect(screen.getByRole('alert').textContent).toBe(
      'این نوع فایل پذیرفته نیست؛ فقط JPG، PNG، PDF.',
    );
    expect((input as HTMLInputElement).value).toBe('');
    expect(seen).toEqual(['fish.pdf', null, null]);
  });

  it('has no serious accessibility finding', async () => {
    const { container } = render(
      <FileDropzone id="doc" name="file" label="مدرک" kinds={KINDS} maxBytes={MB} />,
    );
    const result = await axe.run(container);
    expect(
      result.violations.filter((v) => v.impact === 'serious' || v.impact === 'critical'),
    ).toEqual([]);
  });
});
