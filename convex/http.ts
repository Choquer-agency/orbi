import { httpRouter } from "convex/server";
import { httpAction } from "./_generated/server";
import { internal } from "./_generated/api";
import { auth } from "./auth";
import { addAiHttpRoutes } from "./ai/http";
import { addOAuthHttpRoutes } from "./oauth/http";
import { addTrackingHttpRoutes } from "./tracking/http";
import { addAttachmentHttpRoutes } from "./attachmentsHttp";

const http = httpRouter();

auth.addHttpRoutes(http);
addAiHttpRoutes(http);
addOAuthHttpRoutes(http);
addTrackingHttpRoutes(http);
addAttachmentHttpRoutes(http);

// ── Gmail push webhook ───────────────────────────────────────────────────────
// Cloud Pub/Sub push subscription target. Gmail publishes {emailAddress,
// historyId} the instant a watched mailbox changes; we kick the normal
// incremental sync for that account. Auth: shared secret in ?token= must
// match GMAIL_PUSH_TOKEN (the endpoint does nothing but trigger a sync the
// cron would run anyway, but the token keeps strangers from burning cycles).
// Always 2xx fast — a non-2xx makes Pub/Sub retry with backoff for days.
http.route({
  path: "/gmail/push",
  method: "POST",
  handler: httpAction(async (ctx, req) => {
    const expected = process.env.GMAIL_PUSH_TOKEN;
    const token = new URL(req.url).searchParams.get("token");
    if (!expected || token !== expected) {
      return new Response("forbidden", { status: 403 });
    }
    try {
      const body = (await req.json()) as {
        message?: { data?: string };
      };
      const dataB64 = body.message?.data;
      if (dataB64) {
        const decoded = JSON.parse(
          atob(dataB64.replace(/-/g, "+").replace(/_/g, "/")),
        ) as { emailAddress?: string };
        if (decoded.emailAddress) {
          await ctx.runMutation(internal.sync.gmailData._schedulePushSync, {
            email: decoded.emailAddress.toLowerCase(),
          });
        }
      }
    } catch (err) {
      // Malformed payload — ack anyway so Pub/Sub doesn't retry it forever.
      console.error("[gmail-push] bad push payload:", err);
    }
    return new Response(null, { status: 204 });
  }),
});

export default http;
