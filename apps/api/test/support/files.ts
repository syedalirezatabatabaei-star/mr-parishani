import { randomBytes } from 'node:crypto';
import { CreateBucketCommand, S3Client } from '@aws-sdk/client-s3';
import { GenericContainer, Wait, type StartedTestContainer } from 'testcontainers';

/**
 * S3-compatible storage and ClamAV for the file tests (task 2-8). SeaweedFS stands in for
 * the production S3 provider (task 2-8 decision 1; MinIO no longer publishes its image).
 * Both pinned by digest, pulled through the domestic registry mirror.
 */
export const SEAWEEDFS_IMAGE =
  'chrislusf/seaweedfs@sha256:4e61d15fd35994cb1e43e1e553dff106794841fd9a99ade2fc8c8bfce4d7872d';
export const CLAMAV_IMAGE =
  'clamav/clamav@sha256:ebec5bc138401b36ae987caa1a3fa3c3b2a21ed3d51f0bfa5852825e663e67b0';

export interface StartedStorage {
  readonly container: StartedTestContainer;
  /** The S3_* variables for the API. */
  readonly env: Record<string, string>;
}

/** A SeaweedFS server with an S3 gateway and the two buckets. */
export async function startStorage(): Promise<StartedStorage> {
  const container = await new GenericContainer(SEAWEEDFS_IMAGE)
    // Each bucket is a collection with volumes of its own: room for both, in small volumes.
    .withCommand([
      'server',
      '-dir=/data',
      '-s3',
      '-s3.port=8333',
      '-volume.max=50',
      '-master.volumeSizeLimitMB=64',
    ])
    .withExposedPorts(8333)
    .withWaitStrategy(Wait.forListeningPorts())
    .withStartupTimeout(120_000)
    .start();
  const endpoint = `http://${container.getHost()}:${String(container.getMappedPort(8333))}`;
  const env = {
    S3_ENDPOINT: endpoint,
    S3_REGION: 'us-east-1',
    // SeaweedFS without identities accepts any key; the application still signs. Random per
    // run (task 9-2): no fixed credential-looking literal in the repository (rule 29).
    S3_ACCESS_KEY: randomBytes(12).toString('hex'),
    S3_SECRET_KEY: randomBytes(24).toString('hex'),
    S3_PRIVATE_BUCKET: 'sepehr-private',
    S3_PUBLIC_BUCKET: 'sepehr-public',
    S3_PUBLIC_BASE_URL: `${endpoint}/sepehr-public`,
  };
  const client = new S3Client({
    endpoint,
    region: env.S3_REGION,
    forcePathStyle: true,
    requestChecksumCalculation: 'WHEN_REQUIRED',
    responseChecksumValidation: 'WHEN_REQUIRED',
    credentials: { accessKeyId: env.S3_ACCESS_KEY, secretAccessKey: env.S3_SECRET_KEY },
  });
  // The gateway listens before the filer is ready: retry for a while.
  for (const bucket of [env.S3_PRIVATE_BUCKET, env.S3_PUBLIC_BUCKET]) {
    for (let attempt = 0; ; attempt++) {
      try {
        await client.send(new CreateBucketCommand({ Bucket: bucket }));
        break;
      } catch (error) {
        if (attempt >= 60) throw error;
        await new Promise((r) => setTimeout(r, 1000));
      }
    }
  }
  client.destroy();
  return { container, env };
}

export interface StartedScanner {
  readonly container: StartedTestContainer;
  /** The CLAMAV_* variables for the API. */
  readonly env: Record<string, string>;
}

/**
 * clamd with the signatures the image ships (no update: freshclam is refused from Iran,
 * task 2-8 decision 2). Loading them takes a minute.
 */
export async function startScanner(): Promise<StartedScanner> {
  const container = await new GenericContainer(CLAMAV_IMAGE)
    .withEnvironment({ CLAMAV_NO_FRESHCLAMD: 'true' })
    .withExposedPorts(3310)
    .withWaitStrategy(Wait.forLogMessage('socket found, clamd started'))
    .withStartupTimeout(240_000)
    .start();
  return {
    container,
    env: { CLAMAV_HOST: container.getHost(), CLAMAV_PORT: String(container.getMappedPort(3310)) },
  };
}

/**
 * The EICAR test file every antivirus reports (not malware). Built here from pieces so no
 * file of the repository holds it: Windows Defender quarantines any that does.
 */
export function eicar(): Buffer {
  const parts = ['X5O!P%@AP[4\\PZX54(P^)7CC)7}$', 'EICAR-STANDARD-', 'ANTIVIRUS-TEST-FILE!$H+H*'];
  return Buffer.from(parts.join(''), 'latin1');
}
