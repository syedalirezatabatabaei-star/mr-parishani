import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

const run = promisify(execFile);

export interface HlsFile {
  readonly name: string;
  readonly body: Buffer;
  readonly mime: string;
}

export type TranscodeResult =
  | { readonly ok: true; readonly files: readonly HlsFile[]; readonly seconds: number }
  | { readonly ok: false; readonly reason: 'too_long' };

/**
 * Self-hosted profile video (task 2-8, doc 08 §10, `catalog.profile_video_hosting` =
 * `self`): HLS made in the worker. Not configured without FFMPEG_PATH and FFPROBE_PATH;
 * the worker then refuses such videos (`processing_failed`) rather than keep them raw.
 */
export interface VideoTranscoder {
  readonly configured: boolean;
  toHls(video: Buffer, maxSeconds: number): Promise<TranscodeResult>;
}

export const VIDEO_TRANSCODER = Symbol('VIDEO_TRANSCODER');

/** The ffmpeg arguments: H.264 and AAC, 6-second VOD segments, one rendition. */
export function hlsArguments(input: string, outputDir: string): string[] {
  return [
    '-hide_banner',
    '-loglevel',
    'error',
    '-i',
    input,
    // Nothing of the source's metadata is carried over (location, device).
    '-map_metadata',
    '-1',
    '-c:v',
    'libx264',
    '-preset',
    'veryfast',
    '-crf',
    '23',
    '-vf',
    "scale='min(1280,iw)':-2",
    '-c:a',
    'aac',
    '-b:a',
    '128k',
    '-f',
    'hls',
    '-hls_time',
    '6',
    '-hls_playlist_type',
    'vod',
    '-hls_segment_filename',
    join(outputDir, 'segment-%03d.ts'),
    join(outputDir, 'index.m3u8'),
  ];
}

export class FfmpegTranscoder implements VideoTranscoder {
  constructor(
    private readonly ffmpeg: string | null,
    private readonly ffprobe: string | null,
  ) {}

  get configured() {
    return this.ffmpeg !== null && this.ffprobe !== null;
  }

  async toHls(video: Buffer, maxSeconds: number): Promise<TranscodeResult> {
    if (!this.ffmpeg || !this.ffprobe) throw new Error('ffmpeg is not configured');
    const dir = await mkdtemp(join(tmpdir(), 'sepehr-hls-'));
    try {
      const input = join(dir, 'input');
      const out = join(dir, 'out');
      await writeFile(input, video);
      const probe = await run(this.ffprobe, [
        '-v',
        'error',
        '-show_entries',
        'format=duration',
        '-of',
        'default=noprint_wrappers=1:nokey=1',
        input,
      ]);
      const seconds = Number(probe.stdout.trim());
      if (!Number.isFinite(seconds)) throw new Error('ffprobe gave no duration');
      if (seconds > maxSeconds) return { ok: false, reason: 'too_long' };
      await mkdir(out);
      await run(this.ffmpeg, hlsArguments(input, out), { maxBuffer: 1024 * 1024 });
      const files: HlsFile[] = [];
      for (const name of (await readdir(out)).sort()) {
        files.push({
          name,
          body: await readFile(join(out, name)),
          mime: name.endsWith('.m3u8') ? 'application/vnd.apple.mpegurl' : 'video/mp2t',
        });
      }
      return { ok: true, files, seconds };
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }
}

export function ffmpegTranscoderFromEnv(env: NodeJS.ProcessEnv = process.env) {
  return new FfmpegTranscoder(
    env['FFMPEG_PATH']?.trim() || null,
    env['FFPROBE_PATH']?.trim() || null,
  );
}
