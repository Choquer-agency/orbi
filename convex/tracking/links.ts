import { v } from "convex/values";
import { httpAction, internalMutation } from "../_generated/server";
import { internal } from "../_generated/api";

// ─────────────────────────────────────────────────────────────────────────────
// Link click tracking — ported from packages/backend/src/routes/tracking
// (`GET /t/:trackingId/:linkIndex`).
//
// Looks up the original URL from emailTracking.linkMap, inserts a linkClicks
// row, then issues a 302 redirect. Falls back to https://orbi.agency for
// unknown tracking IDs or invalid link indexes (matches source behavior).
// ─────────────────────────────────────────────────────────────────────────────

const FALLBACK_URL = "https://orbi.agency";

/**
 * Internal mutation: record a single click. Returns the URL to redirect to.
 * Caller decides what to do with the URL (or the fallback) so the http
 * action can issue the redirect.
 */
export const recordClick = internalMutation({
  args: {
    trackingId: v.string(),
    linkIndex: v.string(),
    userAgent: v.optional(v.string()),
    ipAddress: v.optional(v.string()),
  },
  handler: async (ctx, { trackingId, linkIndex, userAgent, ipAddress }) => {
    const tracking = await ctx.db
      .query("emailTracking")
      .withIndex("by_trackingId", (q) => q.eq("trackingId", trackingId))
      .unique();
    if (!tracking || !tracking.linkMap) {
      return { redirectTo: FALLBACK_URL };
    }
    const linkMap = tracking.linkMap as Record<string, string>;
    const originalUrl = linkMap[linkIndex];
    if (!originalUrl) {
      return { redirectTo: FALLBACK_URL };
    }

    if (tracking.isEnabled) {
      await ctx.db.insert("linkClicks", {
        trackingId,
        originalUrl,
        clickedAt: Date.now(),
        userAgent,
        ipAddress,
      });
    }

    return { redirectTo: originalUrl };
  },
});

/**
 * HTTP action: GET /t/<trackingId>/<linkIndex>
 */
export const linkHandler = httpAction(async (ctx, req) => {
  const url = new URL(req.url);
  const match = url.pathname.match(/^\/t\/([^/]+)\/([^/]+)\/?$/);
  if (!match) {
    return Response.redirect(FALLBACK_URL, 302);
  }
  const trackingId = match[1];
  const linkIndex = match[2];
  const userAgent = req.headers.get("User-Agent") ?? undefined;

  let redirectTo = FALLBACK_URL;
  try {
    const result = await ctx.runMutation(
      internal.tracking.links.recordClick,
      { trackingId, linkIndex, userAgent },
    );
    redirectTo = result.redirectTo;
  } catch (err) {
    console.error("recordClick failed", err);
  }

  return Response.redirect(redirectTo, 302);
});
