// Phase 1 — Redis singleton. Used by rate limiter (Phase 3) and BullMQ (Phase 25).
import Redis from 'ioredis';
import { env } from '../config/env.js';

let client: Redis | undefined;

export function getRedis(): Redis {
  if (!client) {
    client = new Redis(env.REDIS_URL, {
      maxRetriesPerRequest: null,
      enableReadyCheck: true,
    });
  }
  return client;
}

export async function pingRedis(): Promise<boolean> {
  try {
    const r = await getRedis().ping();
    return r === 'PONG';
  } catch {
    return false;
  }
}
