/**
 * The real type of a file, from its first bytes, never from its name or the type the
 * browser claims (rule 28, doc 08 §10). Only the types the application accepts are known;
 * anything else is null and refused.
 */
export type DetectedType =
  | { readonly mime: 'image/jpeg'; readonly kind: 'image' }
  | { readonly mime: 'image/png'; readonly kind: 'image' }
  | { readonly mime: 'image/webp'; readonly kind: 'image' }
  | { readonly mime: 'image/avif'; readonly kind: 'image' }
  | { readonly mime: 'video/mp4'; readonly kind: 'video' }
  | { readonly mime: 'video/quicktime'; readonly kind: 'video' }
  | { readonly mime: 'video/webm'; readonly kind: 'video' };

const startsWith = (file: Buffer, bytes: readonly number[], at = 0) =>
  file.length >= at + bytes.length && bytes.every((b, i) => file[at + i] === b);

const ascii = (file: Buffer, from: number, to: number) =>
  file.length >= to ? file.subarray(from, to).toString('latin1') : '';

export function detectFileType(file: Buffer): DetectedType | null {
  if (startsWith(file, [0xff, 0xd8, 0xff])) return { mime: 'image/jpeg', kind: 'image' };
  if (startsWith(file, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) {
    return { mime: 'image/png', kind: 'image' };
  }
  if (ascii(file, 0, 4) === 'RIFF' && ascii(file, 8, 12) === 'WEBP') {
    return { mime: 'image/webp', kind: 'image' };
  }
  if (startsWith(file, [0x1a, 0x45, 0xdf, 0xa3])) return { mime: 'video/webm', kind: 'video' };
  // ISO base media (MP4, QuickTime, AVIF): a box `ftyp` at offset 4 names the brand.
  if (ascii(file, 4, 8) === 'ftyp') {
    const brand = ascii(file, 8, 12);
    if (brand === 'avif' || brand === 'avis') return { mime: 'image/avif', kind: 'image' };
    if (brand === 'qt  ') return { mime: 'video/quicktime', kind: 'video' };
    if (/^(isom|iso[2-9]|mp41|mp42|avc1|dash|M4V |MSNV)$/.test(brand)) {
      return { mime: 'video/mp4', kind: 'video' };
    }
  }
  return null;
}

/** A document of a credit application (task 3-5): a PDF, or a photo (JPEG, PNG). */
export type DocumentType = 'application/pdf' | 'image/jpeg' | 'image/png';

/**
 * The real type of a credit document, from its first bytes (rule 28). Separate from
 * detectFileType, which stays the profile media's list and keeps refusing a PDF.
 */
export function detectDocumentType(file: Buffer): DocumentType | null {
  if (ascii(file, 0, 5) === '%PDF-') return 'application/pdf';
  const image = detectFileType(file)?.mime;
  return image === 'image/jpeg' || image === 'image/png' ? image : null;
}
