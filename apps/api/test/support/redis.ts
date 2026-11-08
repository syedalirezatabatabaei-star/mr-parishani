import { RedisContainer, type StartedRedisContainer } from '@testcontainers/redis';

/** Same major version as docker-compose.yml, pinned by digest. */
export const REDIS_IMAGE =
  'redis:8-alpine@sha256:bd999b5cfee25fb24b8320a31fddbd69f462df44c8138c66e369582937beebc0';

/** A throwaway Redis on a random free host port; use `getConnectionUrl()`. */
export function startRedis(): Promise<StartedRedisContainer> {
  return new RedisContainer(REDIS_IMAGE).start();
}
