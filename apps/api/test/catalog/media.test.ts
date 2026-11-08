import sharp from 'sharp';
import { describe, expect, it } from 'vitest';
import { parseClamdReply } from '../../src/infra/clamd';
import { detectFileType } from '../../src/infra/file-type';
import { s3StorageFromEnv } from '../../src/infra/s3-storage';
import { imageVariants } from '../../src/modules/catalog/media-worker';
import { hlsArguments } from '../../src/modules/catalog/video-transcoder';

const box = (type: string, brand: string) =>
  Buffer.concat([
    Buffer.from([0, 0, 0, 0x20]),
    Buffer.from(type + brand, 'latin1'),
    Buffer.alloc(20),
  ]);

describe('detectFileType (rule 28: the bytes, never the name)', () => {
  it('knows the accepted image and video types by their signatures', async () => {
    const png = await sharp({ create: { width: 4, height: 4, channels: 3, background: '#fff' } })
      .png()
      .toBuffer();
    const jpeg = await sharp(png).jpeg().toBuffer();
    const webp = await sharp(png).webp().toBuffer();
    expect(detectFileType(png)?.mime).toBe('image/png');
    expect(detectFileType(jpeg)?.mime).toBe('image/jpeg');
    expect(detectFileType(webp)?.mime).toBe('image/webp');
    expect(detectFileType(box('ftyp', 'avif'))?.mime).toBe('image/avif');
    expect(detectFileType(box('ftyp', 'isom'))).toEqual({ mime: 'video/mp4', kind: 'video' });
    expect(detectFileType(box('ftyp', 'qt  '))?.mime).toBe('video/quicktime');
    expect(detectFileType(Buffer.from([0x1a, 0x45, 0xdf, 0xa3, 0, 0]))?.mime).toBe('video/webm');
  });

  it('knows nothing else: a PDF, an archive, a script or text is refused', () => {
    expect(detectFileType(Buffer.from('%PDF-1.7\n'))).toBeNull();
    expect(detectFileType(Buffer.from([0x50, 0x4b, 0x03, 0x04, 0, 0]))).toBeNull();
    expect(detectFileType(Buffer.from('MZ\x90\x00', 'latin1'))).toBeNull();
    expect(detectFileType(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>'))).toBeNull();
    expect(detectFileType(Buffer.alloc(0))).toBeNull();
  });
});

describe('parseClamdReply', () => {
  it('reads clean, found, and refuses anything else', () => {
    expect(parseClamdReply('stream: OK\0')).toEqual({ clean: true });
    expect(parseClamdReply('stream: Eicar-Signature FOUND\0')).toEqual({
      clean: false,
      signature: 'Eicar-Signature',
    });
    expect(() => parseClamdReply('INSTREAM size limit exceeded. ERROR\0')).toThrow('clamd');
    expect(() => parseClamdReply('')).toThrow('clamd');
  });
});

describe('s3StorageFromEnv', () => {
  const full = {
    S3_ENDPOINT: 'http://127.0.0.1:8333',
    S3_ACCESS_KEY: 'k',
    S3_SECRET_KEY: 's',
    S3_PRIVATE_BUCKET: 'p',
    S3_PUBLIC_BUCKET: 'q',
    S3_PUBLIC_BASE_URL: 'http://127.0.0.1:8333/q',
  };

  it('is off with nothing set, and on with everything', () => {
    expect(s3StorageFromEnv({}).configured).toBe(false);
    const storage = s3StorageFromEnv(full);
    expect(storage.configured).toBe(true);
    expect(storage.publicUrl('media/a/320.webp')).toBe('http://127.0.0.1:8333/q/media/a/320.webp');
  });

  it('refuses half a configuration, naming what is missing but no value (rule 30)', () => {
    const partial = { ...full, S3_SECRET_KEY: '  ' };
    expect(() => s3StorageFromEnv(partial)).toThrow('missing S3_SECRET_KEY');
    expect(() => s3StorageFromEnv({ ...full, S3_ENDPOINT: 'ftp://x' })).toThrow(
      'S3_ENDPOINT must be an http(s) URL',
    );
    try {
      s3StorageFromEnv({ ...full, S3_ENDPOINT: 'not a url with k' });
    } catch (error) {
      expect(String(error)).not.toContain('not a url');
    }
  });
});

describe('media processing', () => {
  it('drops every metadata block and makes WebP and AVIF at the widths that fit', async () => {
    const photo = await sharp({
      create: { width: 900, height: 600, channels: 3, background: '#88aacc' },
    })
      .withExif({ IFD0: { Make: 'Camera', Copyright: 'Someone' } })
      .jpeg()
      .toBuffer();
    expect((await sharp(photo).metadata()).exif).toBeDefined();

    const made = await imageVariants('asset-1', photo, [320, 640, 1280]);
    expect(made.map((m) => m.variant)).toEqual([
      { key: 'media/asset-1/320.webp', mime: 'image/webp', width: 320 },
      { key: 'media/asset-1/320.avif', mime: 'image/avif', width: 320 },
      { key: 'media/asset-1/640.webp', mime: 'image/webp', width: 640 },
      { key: 'media/asset-1/640.avif', mime: 'image/avif', width: 640 },
    ]);
    for (const { body, variant } of made) {
      const meta = await sharp(body).metadata();
      expect(meta.width).toBe(variant.width);
      expect(meta.exif).toBeUndefined();
      expect(meta.icc).toBeUndefined();
      expect(meta.xmp).toBeUndefined();
    }
  });

  it('a picture narrower than every width gets one variant at its own width', async () => {
    const small = await sharp({
      create: { width: 200, height: 100, channels: 3, background: '#000' },
    })
      .png()
      .toBuffer();
    const made = await imageVariants('asset-2', small, [320, 640]);
    expect(made.map((m) => m.variant.width)).toEqual([200, 200]);
  });

  it('refuses what is not a picture', async () => {
    await expect(imageVariants('asset-3', Buffer.from('not an image'), [320])).rejects.toThrow();
  });

  it('makes HLS without the source metadata', () => {
    const args = hlsArguments('/tmp/in', '/tmp/out');
    expect(args).toContain('-map_metadata');
    expect(args[args.indexOf('-map_metadata') + 1]).toBe('-1');
    expect(args.at(-1)).toMatch(/index\.m3u8$/);
    expect(args[args.indexOf('-hls_playlist_type') + 1]).toBe('vod');
  });
});
