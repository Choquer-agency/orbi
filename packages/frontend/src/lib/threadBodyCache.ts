// Local snapshot cache for full thread bodies.
//
// Opening a thread should feel instant even when the network is slow. We
// render the cached version on first paint, then reconcile with the live
// Convex subscription when it arrives. Same pattern Gmail/Spark use.
//
// Storage layout:
//   key:   'orbi:thr:v1:<threadId>'
//   value: { ts, data } where data is whatever api.threads.get returned
//
// Notes:
// - Includes pre-sanitized email bodies (bodyHtmlClean/bodyHtmlTrimmed) so
//   the iframe renders immediately on cold start.
// - 30-day TTL — threads rarely move; old caches are discarded only to
//   bound disk usage.
// - In-memory mirror so back-and-forth navigation in one session is
//   synchronous (no IDB round-trip).

import { get as idbGet, set as idbSet, del as idbDel } from 'idb-keyval';

const KEY_PREFIX = 'orbi:thr:v1:';
const MAX_AGE_MS = 1000 * 60 * 60 * 24 * 30; // 30 days

interface CachedEntry<T> {
  ts: number;
  data: T;
}

// LRU-capped: the desktop app never reloads, so an unbounded Map slowly
// accumulated the full bodies of every thread ever viewed/prefetched.
const MEMORY_CAP = 150;
const memory = new Map<string, unknown>();

function touchLru(key: string, value: unknown) {
  if (memory.has(key)) memory.delete(key); // re-insert to move to newest
  memory.set(key, value);
  while (memory.size > MEMORY_CAP) {
    const oldest = memory.keys().next().value as string | undefined;
    if (oldest === undefined) break;
    memory.delete(oldest);
  }
}

export function getCachedThreadSync<T>(threadId: string): T | undefined {
  return memory.get(threadId) as T | undefined;
}

export async function loadCachedThread<T>(threadId: string): Promise<T | undefined> {
  const inMem = memory.get(threadId) as T | undefined;
  if (inMem !== undefined) return inMem;
  try {
    const raw = (await idbGet(KEY_PREFIX + threadId)) as CachedEntry<T> | undefined;
    if (!raw) return undefined;
    if (Date.now() - raw.ts > MAX_AGE_MS) {
      void idbDel(KEY_PREFIX + threadId).catch(() => {});
      return undefined;
    }
    touchLru(threadId, raw.data);
    return raw.data;
  } catch {
    return undefined;
  }
}

export function saveCachedThread<T>(threadId: string, data: T): void {
  touchLru(threadId, data);
  try {
    void idbSet(KEY_PREFIX + threadId, { ts: Date.now(), data } satisfies CachedEntry<T>);
  } catch {
    /* noop */
  }
}
