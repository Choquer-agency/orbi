// ─────────────────────────────────────────────────────────────────────────────
// telemetry.ts — records what actually happened in this window.
//
// The team reports bugs over Slack ("compose went weird this morning"). This
// keeps a rolling record of clicks, view changes, failed requests and thrown
// errors so the report can be looked up server-side instead of reconstructed
// by interview.
//
// Design constraints:
//  • Batched. Events buffer locally and ship every ~20s in ONE mutation, so a
//    busy hour is ~180 writes, not thousands.
//  • Bounded. Hard caps on buffer size and string length; oldest events are
//    dropped rather than growing without limit.
//  • Never breaks the app. Every hook is wrapped — telemetry failing must
//    never surface to the user or block a click.
//  • No content. We record WHICH control was used, never what was typed. No
//    email bodies, no recipients, no subjects.
// ─────────────────────────────────────────────────────────────────────────────

import { convex } from './convex';
import { api } from '../../../../convex/_generated/api';
import { uiBuild, shellVersion } from './version';

type Event = Record<string, unknown> & { t: string; ts: number };

const FLUSH_INTERVAL_MS = 20_000;
const FLUSH_AT_EVENTS = 40;
const MAX_BUFFER = 200;
const MAX_STR = 160;

let buffer: Event[] = [];
let started = false;
let flushTimer: ReturnType<typeof setInterval> | null = null;
let shell: string | undefined;
let errorsInBuffer = 0;

function sessionId(): string {
  const KEY = 'orbi-telemetry-session';
  try {
    const existing = sessionStorage.getItem(KEY);
    if (existing) return existing;
    const id = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
    sessionStorage.setItem(KEY, id);
    return id;
  } catch {
    return 'no-storage';
  }
}

function clip(value: unknown): string {
  const s = typeof value === 'string' ? value : String(value ?? '');
  return s.replace(/\s+/g, ' ').trim().slice(0, MAX_STR);
}

/** Record one event. Safe to call from anywhere; never throws. */
export function track(type: string, data: Record<string, unknown> = {}): void {
  try {
    if (!started) return;
    const event: Event = { t: type, ts: Date.now() };
    for (const [k, v] of Object.entries(data)) {
      if (v === undefined || v === null) continue;
      event[k] = typeof v === 'number' || typeof v === 'boolean' ? v : clip(v);
    }
    buffer.push(event);
    if (type === 'error' || type === 'net-fail' || type === 'console-error') {
      errorsInBuffer++;
    }
    // Drop from the FRONT when over budget — recent context matters most.
    if (buffer.length > MAX_BUFFER) buffer = buffer.slice(-MAX_BUFFER);
    if (buffer.length >= FLUSH_AT_EVENTS) void flush();
  } catch {
    /* telemetry must never break the app */
  }
}

export async function flush(): Promise<void> {
  if (buffer.length === 0) return;
  const batch = buffer;
  const errorCount = errorsInBuffer;
  buffer = [];
  errorsInBuffer = 0;
  try {
    await convex.mutation(api.telemetry.record, {
      sessionId: sessionId(),
      uiBuild: uiBuild(),
      shellVersion: shell,
      platform: clip(navigator.userAgent),
      events: JSON.stringify(batch),
      eventCount: batch.length,
      errorCount,
      firstAt: batch[0].ts,
      lastAt: batch[batch.length - 1].ts,
    });
  } catch {
    // Offline or signed out. Drop the batch rather than growing forever —
    // telemetry is best-effort by design.
  }
}

/** Describe the control the user actually clicked. */
function describeTarget(el: Element | null): Record<string, unknown> | null {
  if (!el) return null;
  const control = el.closest(
    'button, a, [role="button"], [role="menuitem"], [role="tab"], input[type="checkbox"], summary',
  );
  if (!control) return null;
  const label =
    control.getAttribute('aria-label') ||
    control.getAttribute('title') ||
    control.textContent ||
    '';
  return {
    tag: control.tagName.toLowerCase(),
    label: clip(label),
    testid: control.getAttribute('data-testid') ?? undefined,
    href: control.getAttribute('href') ?? undefined,
  };
}

/**
 * Begin recording. Call once, after the user is authenticated (so the mutation
 * has an identity to attach the rows to).
 */
export function startTelemetry(): void {
  if (started) return;
  started = true;

  void shellVersion().then((v) => {
    shell = v ?? undefined;
  });

  track('session-start', {
    url: location.pathname,
    viewport: `${window.innerWidth}x${window.innerHeight}`,
    lang: navigator.language,
  });

  // ── Clicks ────────────────────────────────────────────────────────────────
  document.addEventListener(
    'click',
    (e) => {
      const info = describeTarget(e.target as Element);
      if (info) track('click', info);
    },
    { capture: true },
  );

  // ── Uncaught errors ───────────────────────────────────────────────────────
  window.addEventListener('error', (e) => {
    track('error', {
      message: e.message,
      source: `${e.filename}:${e.lineno}:${e.colno}`,
      stack: (e.error as Error | undefined)?.stack,
    });
  });

  window.addEventListener('unhandledrejection', (e) => {
    const reason = e.reason as { message?: string; stack?: string } | string;
    track('error', {
      kind: 'unhandled-rejection',
      message: typeof reason === 'string' ? reason : reason?.message,
      stack: typeof reason === 'string' ? undefined : reason?.stack,
    });
  });

  // ── console.error — this is where Convex surfaces query/mutation failures ─
  const originalConsoleError = console.error.bind(console);
  console.error = (...args: unknown[]) => {
    try {
      const message = args.map((a) => clip(a)).join(' ');
      // Never report on ourselves. A failing telemetry write logs an error,
      // which would be recorded, re-sent, fail again — a feedback loop that
      // grows with every cycle.
      if (!message.includes('telemetry:record')) {
        track('console-error', { message });
      }
    } catch {
      /* ignore */
    }
    originalConsoleError(...args);
  };

  // ── Failed network requests ───────────────────────────────────────────────
  const originalFetch = window.fetch.bind(window);
  window.fetch = async (...args: Parameters<typeof fetch>) => {
    const started = Date.now();
    const url = typeof args[0] === 'string' ? args[0] : (args[0] as Request)?.url ?? '';
    try {
      const res = await originalFetch(...args);
      // Skip the update-check poll — a 404 there is expected offline and would
      // otherwise fill the log with noise.
      if (!res.ok && !url.includes('/index.html?v=')) {
        track('net-fail', { url, status: res.status, ms: Date.now() - started });
      }
      return res;
    } catch (err) {
      track('net-fail', {
        url,
        error: (err as Error)?.message,
        ms: Date.now() - started,
      });
      throw err;
    }
  };

  // ── Visibility / lifecycle ────────────────────────────────────────────────
  document.addEventListener('visibilitychange', () => {
    track('visibility', { state: document.visibilityState });
    if (document.visibilityState === 'hidden') void flush();
  });
  window.addEventListener('pagehide', () => {
    track('session-end', {});
    void flush();
  });

  flushTimer = setInterval(() => void flush(), FLUSH_INTERVAL_MS);
}

export function stopTelemetry(): void {
  if (flushTimer) clearInterval(flushTimer);
  flushTimer = null;
  started = false;
}
