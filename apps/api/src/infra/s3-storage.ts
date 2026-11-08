import {
  CopyObjectCommand,
  DeleteObjectCommand,
  GetObjectCommand,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { ServiceUnavailableException } from '@nestjs/common';
import type { ObjectStorage, StorageSpace } from '../common/storage/object-storage.port';

export const storageUnavailable = () =>
  new ServiceUnavailableException({ error: 'storage_unavailable' });

export interface S3Settings {
  readonly endpoint: string;
  readonly region: string;
  readonly accessKey: string;
  readonly secretKey: string;
  readonly privateBucket: string;
  readonly publicBucket: string;
  /** Where public objects are served; a domestic CDN later only changes this (decision 3). */
  readonly publicBaseUrl: string;
}

/**
 * OBJECT_STORAGE on any S3-compatible server (task 2-8): SeaweedFS locally, the production
 * provider later (decision 1). Path-style addressing, so no bucket DNS is needed. The only
 * network peer is S3_ENDPOINT (rule 17): no AWS default endpoint, region lookup or
 * instance metadata, because the credentials are given.
 */
export class S3ObjectStorage implements ObjectStorage {
  private readonly client: S3Client | null;

  constructor(private readonly settings: S3Settings | null) {
    this.client =
      settings === null
        ? null
        : new S3Client({
            endpoint: settings.endpoint,
            region: settings.region,
            forcePathStyle: true,
            // Checksums only where S3 requires them: the SDK's default (streamed CRC32 trailers)
            // is not understood by every S3-compatible server.
            requestChecksumCalculation: 'WHEN_REQUIRED',
            responseChecksumValidation: 'WHEN_REQUIRED',
            credentials: { accessKeyId: settings.accessKey, secretAccessKey: settings.secretKey },
          });
  }

  get configured() {
    return this.client !== null;
  }

  async put(space: StorageSpace, key: string, body: Buffer, contentType: string) {
    const { client, settings } = this.ready();
    await client.send(
      new PutObjectCommand({
        Bucket: this.bucket(settings, space),
        Key: key,
        Body: body,
        ContentType: contentType,
      }),
    );
  }

  async get(space: StorageSpace, key: string): Promise<Buffer> {
    const { client, settings } = this.ready();
    const result = await client.send(
      new GetObjectCommand({ Bucket: this.bucket(settings, space), Key: key }),
    );
    if (!result.Body) throw new Error('empty object body');
    return Buffer.from(await result.Body.transformToByteArray());
  }

  async copy(from: StorageSpace, key: string, to: StorageSpace, toKey = key) {
    const { client, settings } = this.ready();
    await client.send(
      new CopyObjectCommand({
        Bucket: this.bucket(settings, to),
        Key: toKey,
        CopySource: `${this.bucket(settings, from)}/${key}`,
      }),
    );
  }

  async remove(space: StorageSpace, key: string) {
    const { client, settings } = this.ready();
    await client.send(new DeleteObjectCommand({ Bucket: this.bucket(settings, space), Key: key }));
  }

  async signedUrl(key: string, seconds: number, options?: { inline?: boolean }): Promise<string> {
    const { client, settings } = this.ready();
    return getSignedUrl(
      client,
      new GetObjectCommand({
        Bucket: settings.privateBucket,
        Key: key,
        // Task 9-3 (R12): a download, not a page the browser renders, and never kept in a cache.
        ResponseCacheControl: 'private, no-store',
        ...(options?.inline ? {} : { ResponseContentDisposition: 'attachment' }),
      }),
      { expiresIn: seconds },
    );
  }

  publicUrl(key: string): string {
    const { settings } = this.ready();
    return `${settings.publicBaseUrl.replace(/\/+$/, '')}/${key}`;
  }

  private ready() {
    if (this.client === null || this.settings === null) throw storageUnavailable();
    return { client: this.client, settings: this.settings };
  }

  private bucket(settings: S3Settings, space: StorageSpace) {
    return space === 'private' ? settings.privateBucket : settings.publicBucket;
  }
}

const S3_VARIABLES = [
  'S3_ENDPOINT',
  'S3_ACCESS_KEY',
  'S3_SECRET_KEY',
  'S3_PRIVATE_BUCKET',
  'S3_PUBLIC_BUCKET',
  'S3_PUBLIC_BASE_URL',
] as const;

/**
 * From the S3_* variables. All unset: not configured (the API starts; uploads are refused).
 * Some set and some not: refused at start, naming the missing ones but no value (rule 30).
 */
export function s3StorageFromEnv(env: NodeJS.ProcessEnv = process.env): S3ObjectStorage {
  const value = (name: string) => env[name]?.trim() ?? '';
  const missing = S3_VARIABLES.filter((name) => value(name) === '');
  if (missing.length === S3_VARIABLES.length) return new S3ObjectStorage(null);
  if (missing.length > 0) throw new Error(`S3 is partly configured; missing ${missing.join(', ')}`);
  for (const name of ['S3_ENDPOINT', 'S3_PUBLIC_BASE_URL'] as const) {
    if (!/^https?:\/\/[^/]+/.test(value(name))) throw new Error(`${name} must be an http(s) URL`);
  }
  return new S3ObjectStorage({
    endpoint: value('S3_ENDPOINT'),
    region: value('S3_REGION') || 'us-east-1',
    accessKey: value('S3_ACCESS_KEY'),
    secretKey: value('S3_SECRET_KEY'),
    privateBucket: value('S3_PRIVATE_BUCKET'),
    publicBucket: value('S3_PUBLIC_BUCKET'),
    publicBaseUrl: value('S3_PUBLIC_BASE_URL'),
  });
}
