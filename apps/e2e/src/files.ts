import { randomBytes } from 'node:crypto';
import { CreateBucketCommand, S3Client } from '@aws-sdk/client-s3';
import { GenericContainer, Wait, type StartedTestContainer } from 'testcontainers';

/**
 * Private file storage and the virus scanner for the end-to-end stack (task 3-8: credit
 * documents are uploaded in the browser): the images and settings of the API's file tests
 * (apps/api/test/support/files.ts), pinned by digest.
 */
const SEAWEEDFS_IMAGE =
  'chrislusf/seaweedfs@sha256:4e61d15fd35994cb1e43e1e553dff106794841fd9a99ade2fc8c8bfce4d7872d';
const CLAMAV_IMAGE =
  'clamav/clamav@sha256:ebec5bc138401b36ae987caa1a3fa3c3b2a21ed3d51f0bfa5852825e663e67b0';

export interface StartedService {
  readonly container: StartedTestContainer;
  readonly env: Record<string, string>;
}

/** SeaweedFS with an S3 gateway and the two buckets. */
export async function startStorage(): Promise<StartedService> {
  const container = await new GenericContainer(SEAWEEDFS_IMAGE)
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

/** clamd with the signatures the image ships (no update from outside Iran). */
export async function startScanner(): Promise<StartedService> {
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
