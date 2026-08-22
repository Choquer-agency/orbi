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

// ── ERP messages feed ────────────────────────────────────────────────────────
// The Choquer ERP client Vault asks "every message to/from this address or
// domain". Auth: Authorization: Bearer <ERP_API_KEY> (shared secret set on
// this deployment). Read-only; backed by the emailParticipants index.
http.route({
  path: "/erp/messages",
  method: "GET",
  handler: httpAction(async (ctx, req) => {
    const expected = process.env.ERP_API_KEY;
    const got = req.headers.get("authorization") ?? "";
    if (!expected || got !== `Bearer ${expected}`) {
      return new Response(JSON.stringify({ error: "unauthorized" }), {
        status: 401,
        headers: { "Content-Type": "application/json" },
      });
    }
    const url = new URL(req.url);
    const address = url.searchParams.get("participant") ?? undefined;
    const domain = url.searchParams.get("domain") ?? undefined;
    const limit = Number(url.searchParams.get("limit") ?? "50");
    const messages = await ctx.runQuery(internal.erp.messagesForParticipant, {
      address,
      domain,
      limit: Number.isFinite(limit) ? limit : 50,
    });
    return new Response(JSON.stringify({ messages }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  }),
});

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
          const res: { scheduled: number } = await ctx.runMutation(
            internal.sync.gmailData._schedulePushSync,
            { email: decoded.emailAddress.toLowerCase() },
          );
          console.log(
            `[gmail-push] ${decoded.emailAddress}: scheduled ${res.scheduled} sync(s)`,
          );
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
