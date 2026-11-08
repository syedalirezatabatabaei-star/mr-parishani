import { Inject, Injectable, Logger } from '@nestjs/common';
import type { MediaRejection } from '@sepehr/contracts';
import { and, asc, eq, isNotNull, isNull, sql } from 'drizzle-orm';
import sharp from 'sharp';
import { CONFIG, type ConfigPort } from '../../common/config/config.port';
import { MALWARE_SCANNER, type MalwareScanner } from '../../common/security/malware-scanner.port';
import { OBJECT_STORAGE, type ObjectStorage } from '../../common/storage/object-storage.port';
import { DATABASE, type Database } from '../../db/database.module';
import { detectFileType } from '../../infra/file-type';
import { mediaAssets } from './catalog.schema';
import { VIDEO_TRANSCODER, type VideoTranscoder } from './video-transcoder';

type AssetRow = typeof mediaAssets.$inferSelect;
type Variant = { key: string; mime: string; width?: number };

/** Files per pass; the next pass (seconds later) takes the rest. */
const BATCH = 5;

export interface MediaPassResult {
  readonly ready: number;
  readonly rejected: number;
  readonly madePublic: number;
  readonly withdrawn: number;
}

/**
 * Image variants: auto-rotated, every metadata block dropped (sharp keeps none unless
 * asked: no EXIF, GPS or camera), WebP and AVIF at each configured width not wider than the
 * original (doc 08 §10).
 */
export async function imageVariants(
  assetId: string,
  image: Buffer,
  widths: readonly number[],
): Promise<{ variant: Variant; body: Buffer }[]> {
  const source = sharp(image, { failOn: 'error' }).rotate();
  const { width: original } = await source.metadata();
  const fitting = widths.filter((w) => w <= original);
  const chosen = fitting.length > 0 ? fitting : [Math.min(...widths, original)];
  const out: { variant: Variant; body: Buffer }[] = [];
  for (const width of [...new Set(chosen)].sort((a, b) => a - b)) {
    const resized = source.clone().resize({ width, withoutEnlargement: true });
    out.push({
      variant: { key: `media/${assetId}/${String(width)}.webp`, mime: 'image/webp', width },
      body: await resized.clone().webp({ quality: 80 }).toBuffer(),
    });
    out.push({
      variant: { key: `media/${assetId}/${String(width)}.avif`, mime: 'image/avif', width },
      body: await resized.clone().avif({ quality: 50 }).toBuffer(),
    });
  }
  return out;
}

/**
 * The worker's media job (task 2-8, every 10 seconds). Two idempotent passes, each file in
 * its own short transaction, the slow work (download, scan, conversion) outside any:
 *
 * 1. `pending` files: the real type again, a ClamAV scan (rule 28), then image variants or
 *    HLS; the result is `ready` or `rejected` with a reason. A scanner that cannot be
 *    reached leaves the file pending for the next pass; nothing unscanned becomes ready.
 * 2. The public space follows the published versions: a file a published version shows is
 *    copied there (`published_at`); one no published version shows any more is removed
 *    from it. So nothing unpublished is ever public.
 */
@Injectable()
export class MediaWorker {
  private readonly logger = new Logger(MediaWorker.name);

  constructor(
    @Inject(DATABASE) private readonly db: Database,
    @Inject(CONFIG) private readonly config: ConfigPort,
    @Inject(OBJECT_STORAGE) private readonly storage: ObjectStorage,
    @Inject(MALWARE_SCANNER) private readonly scanner: MalwareScanner,
    @Inject(VIDEO_TRANSCODER) private readonly transcoder: VideoTranscoder,
  ) {}

  async run(): Promise<MediaPassResult> {
    if (!this.storage.configured) return { ready: 0, rejected: 0, madePublic: 0, withdrawn: 0 };
    const processed = await this.processPending();
    const published = await this.syncPublic();
    return { ...processed, ...published };
  }

  private async processPending() {
    const pending = await this.db
      .select()
      .from(mediaAssets)
      .where(eq(mediaAssets.status, 'pending'))
      .orderBy(asc(mediaAssets.createdAt))
      .limit(BATCH);
    let ready = 0;
    let rejected = 0;
    for (const asset of pending) {
      let outcome: { variants: Variant[] } | { rejection: MediaRejection } | null;
      try {
        outcome = await this.process(asset);
      } catch (error) {
        // Ids only (rule 30). Left pending: the next pass tries again.
        this.logger.error(
          `media ${asset.id} not processed: ${error instanceof Error ? error.message : 'unknown error'}`,
        );
        continue;
      }
      if (outcome === null) continue;
      const done = await this.db
        .update(mediaAssets)
        .set(
          'variants' in outcome
            ? { status: 'ready', variants: outcome.variants }
            : { status: 'rejected', rejection: outcome.rejection },
        )
        .where(and(eq(mediaAssets.id, asset.id), eq(mediaAssets.status, 'pending')))
        .returning({ id: mediaAssets.id });
      if (done.length === 0) continue;
      if ('variants' in outcome) ready++;
      else rejected++;
    }
    return { ready, rejected };
  }

  /** Null: not decided yet (the scanner is away); try again later. */
  private async process(
    asset: AssetRow,
  ): Promise<{ variants: Variant[] } | { rejection: MediaRejection } | null> {
    const file = await this.storage.get('private', asset.originalKey);
    if (detectFileType(file)?.mime !== asset.detectedMime) return { rejection: 'unsupported_type' };
    if (!this.scanner.configured) return null;
    const scan = await this.scanner.scan(file);
    if (!scan.clean) {
      // The signature name, never the file: an operator can look it up (rule 30).
      this.logger.warn(`media ${asset.id} rejected by the scanner: ${scan.signature}`);
      return { rejection: 'infected' };
    }
    const policy = (await this.config.resolve('catalog.profile_media_policy')).value;
    if (asset.kind === 'image') {
      let made: { variant: Variant; body: Buffer }[];
      try {
        made = await imageVariants(asset.id, file, policy.imageWidths);
      } catch {
        return { rejection: 'processing_failed' };
      }
      for (const { variant, body } of made) {
        await this.storage.put('private', variant.key, body, variant.mime);
      }
      return { variants: made.map((m) => m.variant) };
    }
    if (!this.transcoder.configured) {
      this.logger.warn(`media ${asset.id} rejected: no ffmpeg for self-hosted video`);
      return { rejection: 'processing_failed' };
    }
    const result = await this.transcoder.toHls(file, policy.videoMaxSeconds);
    if (!result.ok) return { rejection: result.reason };
    const variants: Variant[] = [];
    for (const f of result.files) {
      const key = `media/${asset.id}/hls/${f.name}`;
      await this.storage.put('private', key, f.body, f.mime);
      if (f.name === 'index.m3u8') variants.push({ key, mime: f.mime });
    }
    // Segments are published with their playlist; the playlist is the variant shown.
    for (const f of result.files) {
      if (f.name !== 'index.m3u8') {
        variants.push({ key: `media/${asset.id}/hls/${f.name}`, mime: f.mime });
      }
    }
    return { variants };
  }

  /** The files published versions show, now; and those in the public space. */
  private async syncPublic() {
    const shown = await this.db.execute(sql`
      SELECT DISTINCT a.id
      FROM doctor_profiles p
      JOIN doctor_profile_versions v ON v.id = p.published_version_id
      JOIN media_assets a ON a.status = 'ready' AND a.id::text IN (
        v.content->>'photoAssetId',
        CASE WHEN v.content->'video'->>'hosting' = 'self'
          THEN v.content->'video'->>'assetId' END)
    `);
    const shownIds = new Set(shown.rows.map((r) => String(r['id'])));

    let madePublic = 0;
    const toPublish = await this.db
      .select()
      .from(mediaAssets)
      .where(and(eq(mediaAssets.status, 'ready'), isNull(mediaAssets.publishedAt)));
    for (const asset of toPublish.filter((a) => shownIds.has(a.id))) {
      for (const v of asset.variants ?? []) await this.storage.copy('private', v.key, 'public');
      await this.db
        .update(mediaAssets)
        .set({ publishedAt: sql`now()` })
        .where(and(eq(mediaAssets.id, asset.id), isNull(mediaAssets.publishedAt)));
      madePublic++;
    }

    let withdrawn = 0;
    const public_ = await this.db
      .select()
      .from(mediaAssets)
      .where(isNotNull(mediaAssets.publishedAt));
    for (const asset of public_.filter((a) => !shownIds.has(a.id))) {
      for (const v of asset.variants ?? []) await this.storage.remove('public', v.key);
      await this.db
        .update(mediaAssets)
        .set({ publishedAt: null })
        .where(eq(mediaAssets.id, asset.id));
      withdrawn++;
    }
    return { madePublic, withdrawn };
  }
}
