import { v } from "convex/values";
import { httpAction, internalMutation } from "../_generated/server";
import { internal } from "../_generated/api";

// ─────────────────────────────────────────────────────────────────────────────
// Tracking pixel — ported from packages/backend/src/routes/tracking
// (`GET /p/:trackingId.png`) and services/tracking/pixel.ts.
//
// No auth: trackingId is a public, opaque random ID embedded in the email.
// Returns a 1×1 transparent GIF on every hit (including unknown IDs) so we
// never leak the existence of a tracking record.
// ─────────────────────────────────────────────────────────────────────────────

// 1×1 transparent GIF (43 bytes). GIF is used here (vs PNG in the source)
// because the byte sequence is well-known and easy to verify. Mail clients
// accept either; Content-Type matches.
const PIXEL = new Uint8Array([
  0x47, 0x49, 0x46, 0x38, 0x39, 0x61, 0x01, 0x00, 0x01, 0x00, 0x80, 0x00, 0x00,
  0xff, 0xff, 0xff, 0x00, 0x00, 0x00, 0x21, 0xf9, 0x04, 0x01, 0x00, 0x00, 0x00,
  0x00, 0x2c, 0x00, 0x00, 0x00, 0x00, 0x01, 0x00, 0x01, 0x00, 0x00, 0x02, 0x02,
  0x44, 0x01, 0x00, 0x3b,
]);

/**
 * Internal mutation: record a single open. Looks up tracking by the public
 * trackingId, inserts an emailOpens row, increments the counter on
 * emailTracking. No-ops if the tracking record is missing or disabled.
 */
export const recordOpen = internalMutation({
  args: {
    trackingId: v.string(),
    userAgent: v.optional(v.string()),
    ipAddress: v.optional(v.string()),
  },
  handler: async (ctx, { trackingId, userAgent, ipAddress }) => {
    const tracking = await ctx.db
      .query("emailTracking")
      .withIndex("by_trackingId", (q) => q.eq("trackingId", trackingId))
      .unique();
    if (!tracking || !tracking.isEnabled) return;

    await ctx.db.insert("emailOpens", {
      trackingId,
      openedAt: Date.now(),
      userAgent,
      ipAddress,
    });
    await ctx.db.patch(tracking._id, {
      openCount: (tracking.openCount ?? 0) + 1,
      lastOpenedAt: Date.now(),
    });
  },
});

/**
 * HTTP action: GET /p/<trackingId>.png
 * Always returns the pixel — even if the tracking record is unknown.
 */
export const pixelHandler = httpAction(async (ctx, req) => {
  const url = new URL(req.url);
  const match = url.pathname.match(/^\/p\/(.+)\.png$/);
  if (!match) {
    return new Response("Not found", { status: 404 });
  }
  const trackingId = match[1];
  const userAgent = req.headers.get("User-Agent") ?? undefined;

  // Best-effort record; never block the pixel response.
  try {
    await ctx.runMutation(internal.tracking.pixel.recordOpen, {
      trackingId,
      userAgent,
    });
  } catch (err) {
    console.error("recordOpen failed", err);
  }

  return new Response(PIXEL, {
    headers: {
      "Content-Type": "image/gif",
      "Cache-Control": "no-cache, no-store, must-revalidate",
      Pragma: "no-cache",
      Expires: "0",
    },
  });
});
