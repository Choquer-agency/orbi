"use node";

// ─────────────────────────────────────────────────────────────────────────────
// gmailPush.ts — Gmail real-time push via users.watch + Cloud Pub/Sub.
//
// Flow: for each active Gmail account we register a `users.watch` pointing at
// the Pub/Sub topic in GMAIL_PUSH_TOPIC. Gmail then publishes a message the
// instant the mailbox changes; the push subscription POSTs it to our
// /gmail/push HTTP endpoint (see convex/http.ts), which kicks the normal
// incremental sync for that account. Mail lands in seconds instead of on the
// 1-minute poll — and watched accounts are SKIPPED by the 1-min poll cron,
// so this is also cheaper.
//
// Watches expire after ~7 days; the hourly `gmail-watch-renewal` cron re-
// registers any watch with <24h left. If the push pipeline ever breaks, the
// watch simply lapses and the account falls back to polling automatically —
// no mail is ever lost to a push failure (a 10-min fallback poll also covers
// watched accounts against dropped Pub/Sub messages).
//
// Required env (set with `npx convex env set --prod`):
//   GMAIL_PUSH_TOPIC  e.g. projects/my-gcp-project/topics/orbi-gmail-push
//   GMAIL_PUSH_TOKEN  shared secret; must match the ?token= on the push
//                     subscription's endpoint URL
// Without GMAIL_PUSH_TOPIC this file no-ops and everything polls as before.
// ─────────────────────────────────────────────────────────────────────────────

import { internalAction } from "../_generated/server";
import { internal } from "../_generated/api";
import { withRefreshOn401 } from "../oauth/tokenManager";
import type { Id } from "../_generated/dataModel";

const RENEW_WHEN_LEFT_MS = 24 * 60 * 60 * 1000;

export const renewWatches = internalAction({
  args: {},
  handler: async (ctx) => {
    const topic = process.env.GMAIL_PUSH_TOPIC;
    if (!topic) {
      return { status: "disabled", reason: "GMAIL_PUSH_TOPIC not set" };
    }

    const accounts: Array<{
      _id: Id<"mailAccounts">;
      email: string;
      watchExpiration?: number;
    }> = await ctx.runQuery(internal.sync.gmailData._listActiveAccounts, {});

    const now = Date.now();
    let renewed = 0;
    let failed = 0;
    for (const account of accounts) {
      const exp = account.watchExpiration;
      if (exp !== undefined && exp - now > RENEW_WHEN_LEFT_MS) continue;
      try {
        const res = await withRefreshOn401(ctx, account._id, async (token) => {
          const r = await fetch(
            "https://gmail.googleapis.com/gmail/v1/users/me/watch",
            {
              method: "POST",
              headers: {
                Authorization: `Bearer ${token}`,
                "Content-Type": "application/json",
              },
              body: JSON.stringify({ topicName: topic }),
            },
          );
          if (!r.ok) {
            const text = await r.text();
            throw new Error(`users.watch failed (${r.status}): ${text.slice(0, 300)}`);
          }
          return (await r.json()) as { historyId?: string; expiration?: string };
        });
        const expiration = res.expiration ? Number(res.expiration) : undefined;
        await ctx.runMutation(internal.sync.gmailData._setWatchState, {
          accountId: account._id,
          watchExpiration: expiration,
        });
        renewed++;
      } catch (err) {
        failed++;
        console.error(
          `[gmail-push] watch renewal failed for ${account.email}:`,
          err,
        );
        // Clear a stale expiration so the poll cron takes over immediately
        // instead of trusting a watch that no longer exists.
        if (account.watchExpiration !== undefined) {
          await ctx.runMutation(internal.sync.gmailData._setWatchState, {
            accountId: account._id,
            watchExpiration: undefined,
          });
        }
      }
    }
    return { status: "ok", renewed, failed, total: accounts.length };
  },
});
