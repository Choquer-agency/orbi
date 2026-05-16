// Local snapshot cache for thread lists.
//
// On cold start the thread list is rendered from this cache before the
// Convex subscription resolves. Inspired by Spark / Gmail: clients keep
// a local mirror of the most-recently-seen page-1 of each view so the
// inbox is instant on launch.
//
// Storage layout:
//   key:   'orbi:tl:v1:<paramsKey>'
//   value: ThreadListResponse (the raw page returned by api.threads.list)
//
// We also keep an in-memory map so that intra-session view switches
// (e.g. Inbox → Sent → Inbox) re-render synchronously without an IDB
// roundtrip.

import { get as idbGet, set as idbSet, del as idbDel } from 'idb-keyval';

const KEY_PREFIX = 'orbi:tl:v1:';
const MAX_AGE_MS = 1000 * 60 * 60 * 24 * 7; // 7 days; older cached pages are discarded

interface CachedEntry<T> {
  ts: number;
  data: T;
}

const memory = new Map<string, unknown>();

export function getCachedPageSync<T>(paramsKey: string): T | undefined {
  return memory.get(paramsKey) as T | undefined;
}

export async function loadCachedPage<T>(paramsKey: string): Promise<T | undefined> {
  const inMem = memory.get(paramsKey) as T | undefined;
  if (inMem !== undefined) return inMem;
  try {
    const raw = (await idbGet(KEY_PREFIX + paramsKey)) as CachedEntry<T> | undefined;
    if (!raw) return undefined;
    if (Date.now() - raw.ts > MAX_AGE_MS) {
      // Stale → drop it, don't return it.
      void idbDel(KEY_PREFIX + paramsKey).catch(() => {});
      return undefined;
    }
    memory.set(paramsKey, raw.data);
    return raw.data;
  } catch {
    return undefined;
  }
}

export function saveCachedPage<T>(paramsKey: string, data: T): void {
  memory.set(paramsKey, data);
  // Fire-and-forget persist. Never block the UI on disk writes.
  try {
    void idbSet(KEY_PREFIX + paramsKey, { ts: Date.now(), data } satisfies CachedEntry<T>);
  } catch {
    /* noop */
  }
}
