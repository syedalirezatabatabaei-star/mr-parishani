'use client';

import { useEffect, useId, useMemo, useRef, useState } from 'react';
import { faDigits } from './format.js';
import { Glyph } from './glyphs.js';

/** A file kind a form takes: its media type, its extensions and its name for people. */
export interface FileKind {
  readonly mime: string;
  readonly extensions: readonly string[];
  readonly name: string;
}

export const FILE_KINDS = {
  pdf: { mime: 'application/pdf', extensions: ['.pdf'], name: 'PDF' },
  jpg: { mime: 'image/jpeg', extensions: ['.jpg', '.jpeg'], name: 'JPG' },
  png: { mime: 'image/png', extensions: ['.png'], name: 'PNG' },
  xlsx: {
    mime: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    extensions: ['.xlsx'],
    name: 'Excel',
  },
  csv: { mime: 'text/csv', extensions: ['.csv'], name: 'CSV' },
} as const satisfies Record<string, FileKind>;

/** A size as people read it: «۸۰۰ کیلوبایت», «۲٫۴ مگابایت». */
export function fileSize(bytes: number): string {
  if (bytes < 1024 * 1024) return `${faDigits(Math.max(1, Math.round(bytes / 1024)))} کیلوبایت`;
  const mb = Math.round((bytes / (1024 * 1024)) * 10) / 10;
  return `${faDigits(String(mb).replace('.', '٫'))} مگابایت`;
}

/** What is wrong with a chosen file for this field, in Persian; null when it may be sent. */
export function fileProblem(
  file: { name: string; type: string; size: number },
  kinds: readonly FileKind[],
  maxBytes: number,
): string | null {
  const name = file.name.toLowerCase();
  const allowed = kinds.some(
    (k) => k.mime === file.type || k.extensions.some((e) => name.endsWith(e)),
  );
  if (!allowed) return `این نوع فایل پذیرفته نیست؛ فقط ${kinds.map((k) => k.name).join('، ')}.`;
  if (file.size > maxBytes) return `حجم فایل بیش از ${fileSize(maxBytes)} است.`;
  if (file.size === 0) return 'فایل خالی است.';
  return null;
}

export interface FileDropzoneProps {
  readonly id: string;
  /** The form field's name: the file is read from the form as before. */
  readonly name: string;
  readonly label: string;
  readonly kinds: readonly FileKind[];
  readonly maxBytes: number;
  readonly required?: boolean;
  /** Sending now: an indeterminate progress bar under the file. */
  readonly busy?: boolean;
  /** The server's answer about this file (a scan refused, a type refused). */
  readonly error?: string | null;
  /** Told whenever the chosen file changes (none: null). */
  readonly onFileChange?: (file: File | null) => void;
}

/**
 * Every upload of the panels (owner 1405/08/11): a large dashed box to tap, or to drop a file
 * on; the allowed kinds and size under it; once chosen, the file's name, size and a thumbnail
 * (an icon for a PDF), with «حذف» and «تغییر فایل»; the field checked in the page before it is
 * sent (the server still checks it, and scans it, as before). The real `<input type=file>` holds
 * the file, so a form reads it as it did; it is hidden from sight only, so the browser's English
 * «Choose File» never shows, and it keeps the keyboard and the screen reader.
 */
export function FileDropzone({
  id,
  name,
  label,
  kinds,
  maxBytes,
  required = false,
  busy = false,
  error = null,
  onFileChange,
}: FileDropzoneProps) {
  const input = useRef<HTMLInputElement>(null);
  const [file, setFile] = useState<File | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [dragging, setDragging] = useState(false);
  const hintId = useId();
  const errorId = useId();
  const accept = kinds.flatMap((k) => [k.mime, ...k.extensions]).join(',');
  const shown = problem ?? error;

  // A thumbnail of a chosen photo, released once it is not shown.
  const preview = useMemo(
    () => (file?.type.startsWith('image/') ? URL.createObjectURL(file) : null),
    [file],
  );
  useEffect(
    () => () => {
      if (preview) URL.revokeObjectURL(preview);
    },
    [preview],
  );

  // A form reset empties the input; the box follows.
  useEffect(() => {
    const form = input.current?.form;
    if (!form) return;
    const reset = () => {
      setFile(null);
      setProblem(null);
      onFileChange?.(null);
    };
    form.addEventListener('reset', reset);
    return () => {
      form.removeEventListener('reset', reset);
    };
  }, [onFileChange]);

  /** Takes a file from the picker or a drop: checked, kept in the input, or refused. */
  const take = (chosen: File | null) => {
    const el = input.current;
    if (!el) return;
    if (!chosen) {
      el.value = '';
      setFile(null);
      setProblem(null);
      onFileChange?.(null);
      return;
    }
    const wrong = fileProblem(chosen, kinds, maxBytes);
    if (wrong) {
      el.value = '';
      setFile(null);
      setProblem(wrong);
      onFileChange?.(null);
      return;
    }
    if (el.files?.[0] !== chosen) {
      const transfer = new DataTransfer();
      transfer.items.add(chosen);
      el.files = transfer.files;
    }
    setFile(chosen);
    setProblem(null);
    onFileChange?.(chosen);
  };

  const kindsText = `${kinds.map((k) => k.name).join('، ')} تا ${fileSize(maxBytes)}`;
  return (
    <div className="space-y-1.5">
      <div className="flex items-center gap-2">
        <span id={`${id}-label`} className="text-[length:var(--text-sm)] font-medium">
          {label}
        </span>
        {required && (
          <span className="rounded-full bg-highlight-soft px-2 text-[length:var(--text-xs)] font-medium text-on-highlight-soft">
            الزامی
          </span>
        )}
      </div>
      <input
        ref={input}
        id={id}
        name={name}
        type="file"
        accept={accept}
        required={required}
        aria-labelledby={`${id}-label ${id}-action`}
        aria-describedby={[hintId, shown ? errorId : null].filter(Boolean).join(' ')}
        aria-invalid={shown ? true : undefined}
        className="peer sr-only"
        onChange={(e) => {
          take(e.target.files?.[0] ?? null);
        }}
      />
      {!file ? (
        <label
          htmlFor={id}
          onDragOver={(e) => {
            e.preventDefault();
            setDragging(true);
          }}
          onDragLeave={() => {
            setDragging(false);
          }}
          onDrop={(e) => {
            e.preventDefault();
            setDragging(false);
            take(e.dataTransfer.files[0] ?? null);
          }}
          className={`flex min-h-32 cursor-pointer flex-col items-center justify-center gap-2 rounded-lg border-2 border-dashed p-4 text-center transition-colors peer-focus-visible:outline-3 peer-focus-visible:outline-offset-2 peer-focus-visible:outline-focus hover:border-accent hover:bg-accent-soft/40 ${
            dragging
              ? 'border-accent bg-accent-soft'
              : shown
                ? 'border-danger bg-danger-soft/40'
                : 'border-border-strong bg-sunken/40'
          }`}
        >
          <span className="grid size-12 place-items-center rounded-full bg-accent-soft text-on-accent-soft">
            <Glyph name="upload" className="size-6" />
          </span>
          <span id={`${id}-action`} className="font-medium">
            <span className="pointer-coarse:hidden">
              برای انتخاب فایل اینجا ضربه بزنید یا فایل را بکشید و رها کنید
            </span>
            <span className="hidden pointer-coarse:inline">انتخاب فایل یا گرفتن عکس</span>
          </span>
        </label>
      ) : (
        <div className="space-y-2 rounded-lg border border-border bg-surface p-3">
          <div className="flex items-center gap-3">
            {preview ? (
              <img src={preview} alt="" className="size-14 shrink-0 rounded-md object-cover" />
            ) : (
              <span className="grid size-14 shrink-0 place-items-center rounded-md bg-sunken text-ink-muted">
                <Glyph
                  name={file.type === 'application/pdf' ? 'proforma' : 'report'}
                  className="size-7"
                />
              </span>
            )}
            <div className="min-w-0 flex-1">
              <p className="truncate font-medium" dir="auto">
                {file.name}
              </p>
              <p className="figures text-[length:var(--text-xs)] text-ink-muted">
                {fileSize(file.size)}
              </p>
            </div>
            <div className="flex shrink-0 flex-col gap-1 sm:flex-row">
              <label
                htmlFor={id}
                id={`${id}-action`}
                className="inline-flex min-h-9 cursor-pointer items-center rounded-md px-2 text-[length:var(--text-sm)] font-medium text-accent hover:bg-sunken"
              >
                تغییر فایل
              </label>
              <button
                type="button"
                disabled={busy}
                aria-label={`حذف ${file.name}`}
                onClick={() => {
                  take(null);
                  input.current?.focus();
                }}
                className="inline-flex min-h-9 items-center rounded-md px-2 text-[length:var(--text-sm)] font-medium text-danger hover:bg-sunken"
              >
                حذف
              </button>
            </div>
          </div>
          {busy && (
            <div
              role="progressbar"
              aria-label={`در حال ارسال ${file.name}`}
              className="h-1.5 overflow-hidden rounded-full bg-sunken"
            >
              <div className="h-full w-1/3 animate-pulse rounded-full bg-accent" />
            </div>
          )}
        </div>
      )}
      <p id={hintId} className="figures text-[length:var(--text-xs)] text-ink-subtle">
        {kindsText}
      </p>
      {shown && (
        <p id={errorId} role="alert" className="text-[length:var(--text-sm)] text-danger">
          {shown}
        </p>
      )}
    </div>
  );
}
