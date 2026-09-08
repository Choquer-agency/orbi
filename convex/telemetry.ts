// ─────────────────────────────────────────────────────────────────────────────
// telemetry.ts — session recording for team bug reports.
//
// A teammate hits a problem and Slacks Bryce about it. Rather than asking them
// to reproduce it or copy a console log, we read what their window actually
// did: clicks, view changes, failed requests, thrown errors — all stamped with
// the exact UI build they were running.
//
// Write path : `record` (called by the browser, batched ~every 20s)
// Read path  : `_debugSessions` / `_debugEvents` (internal — run from the CLI)
// Cleanup    : `purgeOldTelemetry`, daily cron
// ─────────────────────────────────────────────────────────────────────────────

import { v } from "convex/values";
import { mutation, internalQuery, internalMutation } from "./_generated/server";
import { requireUser } from "./lib/auth";

/** Keep a week. Long enough for "it broke on Friday", short enough to stay cheap. */
export const TELEMETRY_RETENTION_DAYS = 7;

// Guardrails so a runaway loop in the browser can never write unbounded data.
const MAX_EVENTS_PER_BATCH = 200;
const MAX_BATCH_CHARS = 60_000;

export const record = mutation({
  args: {
    sessionId: v.string(),
    uiBuild: v.string(),
    shellVersion: v.optional(v.string()),
    platform: v.string(),
    // JSON-encoded array of events. Encoded client-side so the shape can
    // evolve without a schema change.
    events: v.string(),
    eventCount: v.number(),
    errorCount: v.number(),
    firstAt: v.number(),
    lastAt: v.number(),
  },
  handler: async (ctx, args) => {
    const userId = await requireUser(ctx);
    if (args.eventCount <= 0) return { ok: true, stored: false };
    if (args.eventCount > MAX_EVENTS_PER_BATCH) {
      return { ok: true, stored: false, reason: "too-many-events" };
    }
    if (args.events.length > MAX_BATCH_CHARS) {
      return { ok: true, stored: false, reason: "too-large" };
    }

    const user = await ctx.db.get(userId);
    await ctx.db.insert("telemetryBatches", {
      userId,
      userEmail: user?.email ?? "",
      sessionId: args.sessionId.slice(0, 64),
      uiBuild: args.uiBuild.slice(0, 64),
      shellVersion: args.shellVersion?.slice(0, 32),
      platform: args.platform.slice(0, 64),
      events: args.events,
      eventCount: args.eventCount,
      errorCount: args.errorCount,
      firstAt: args.firstAt,
      lastAt: args.lastAt,
    });
    return { ok: true, stored: true };
  },
});

// ─────────────────────────────────────────────────────────────────────────────
// Read path — internal, so it can only be run from the CLI / dashboard.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Sessions overview: who was using Orbi, on which build, and how many errors
 * they hit. Start here, then pull one session's events with `_debugEvents`.
 *
 *   npx convex run telemetry:_debugSessions '{"sinceHours":24}'
 */
export const _debugSessions = internalQuery({
  args: {
    sinceHours: v.optional(v.number()),
    email: v.optional(v.string()),
    onlyErrors: v.optional(v.boolean()),
  },
  handler: async (ctx, { sinceHours, email, onlyErrors }) => {
    const since = Date.now() - (sinceHours ?? 24) * 3600_000;
    const rows = await ctx.db
      .query("telemetryBatches")
      .withIndex("by_lastAt", (q) => q.gt("lastAt", since))
      .order("desc")
      .take(3000);

    const wanted = email?.toLowerCase();
    const bySession = new Map<string, any>();
    for (const r of rows) {
      if (wanted && r.userEmail.toLowerCase() !== wanted) continue;
      const cur = bySession.get(r.sessionId);
      if (!cur) {
        bySession.set(r.sessionId, {
          sessionId: r.sessionId,
          user: r.userEmail,
          uiBuild: r.uiBuild,
          shellVersion: r.shellVersion ?? null,
          platform: r.platform,
          batches: 1,
          events: r.eventCount,
          errors: r.errorCount,
          startedAt: new Date(r.firstAt).toISOString(),
          lastSeenAt: new Date(r.lastAt).toISOString(),
        });
      } else {
        cur.batches++;
        cur.events += r.eventCount;
        cur.errors += r.errorCount;
        if (r.firstAt < new Date(cur.startedAt).getTime())
          cur.startedAt = new Date(r.firstAt).toISOString();
        if (r.lastAt > new Date(cur.lastSeenAt).getTime())
          cur.lastSeenAt = new Date(r.lastAt).toISOString();
      }
    }
    let out = Array.from(bySession.values());
    if (onlyErrors) out = out.filter((s) => s.errors > 0);
    out.sort((a, b) => (a.lastSeenAt < b.lastSeenAt ? 1 : -1));
    return out;
  },
});

/**
 * Full event stream for one session (or for one person's last N hours).
 *
 *   npx convex run telemetry:_debugEvents '{"sessionId":"..."}'
 *   npx convex run telemetry:_debugEvents '{"email":"lauren@choquer.agency","sinceHours":3,"onlyErrors":true}'
 */
export const _debugEvents = internalQuery({
  args: {
    sessionId: v.optional(v.string()),
    email: v.optional(v.string()),
    sinceHours: v.optional(v.number()),
    onlyErrors: v.optional(v.boolean()),
    limit: v.optional(v.number()),
  },
  handler: async (ctx, { sessionId, email, sinceHours, onlyErrors, limit }) => {
    const cap = limit ?? 400;
    let rows;
    if (sessionId) {
      rows = await ctx.db
        .query("telemetryBatches")
        .withIndex("by_session_firstAt", (q) => q.eq("sessionId", sessionId))
        .order("asc")
        .take(500);
    } else {
      const since = Date.now() - (sinceHours ?? 6) * 3600_000;
      const all = await ctx.db
        .query("telemetryBatches")
        .withIndex("by_lastAt", (q) => q.gt("lastAt", since))
        .order("asc")
        .take(3000);
      const wanted = email?.toLowerCase();
      rows = wanted
        ? all.filter((r) => r.userEmail.toLowerCase() === wanted)
        : all;
    }

    const events: any[] = [];
    for (const r of rows) {
      let parsed: any[] = [];
      try {
        parsed = JSON.parse(r.events);
      } catch {
        continue;
      }
      for (const e of parsed) {
        if (onlyErrors && e.t !== "error" && e.t !== "net-fail" && e.t !== "console-error")
          continue;
        events.push({
          at: new Date(e.ts).toISOString(),
          type: e.t,
          ...e,
          ts: undefined,
          t: undefined,
          user: r.userEmail,
          uiBuild: r.uiBuild,
          session: r.sessionId,
        });
      }
    }
    events.sort((a, b) => (a.at < b.at ? -1 : 1));
    return events.slice(-cap);
  },
});

// ─────────────────────────────────────────────────────────────────────────────
// Cleanup
// ─────────────────────────────────────────────────────────────────────────────

export const purgeOldTelemetry = internalMutation({
  args: {},
  handler: async (ctx) => {
    const cutoff = Date.now() - TELEMETRY_RETENTION_DAYS * 24 * 3600_000;
    const stale = await ctx.db
      .query("telemetryBatches")
      .withIndex("by_lastAt", (q) => q.lt("lastAt", cutoff))
      .take(2000);
    for (const row of stale) await ctx.db.delete(row._id);
    return { deleted: stale.length };
  },
});
