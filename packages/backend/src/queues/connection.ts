import { env } from '../config/env.js';

/**
 * Returns a BullMQ-compatible connection config.
 * We pass the URL string and let BullMQ use its own bundled ioredis.
 */
export function getQueueConnection() {
  // Parse the Redis URL into host/port/password for BullMQ's IORedis options
  const url = new URL(env.REDIS_URL);
  return {
    host: url.hostname,
    port: parseInt(url.port || '6379', 10),
    password: url.password || undefined,
    maxRetriesPerRequest: null as null,
  };
}
