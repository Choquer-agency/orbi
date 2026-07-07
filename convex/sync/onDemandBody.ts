"use node";

// ─────────────────────────────────────────────────────────────────────────────
// onDemandBody.ts — Fetch a single email's full body on demand.
//
// Why this exists: incremental sync (gmail.ts / microsoft.ts) only pulls
// headers + snippet to keep fetch egress small. The full HTML body is
// downloaded the first time the user opens the message and then cached in
// `emailBodies`. This file owns that on-demand fetch.
//
// Exposed as a public `action` so the frontend can call it via `useAction`
// when it notices the body field is empty. Idempotent — calling it for an
// email that already has a body row is a fast no-op.
// ─────────────────────────────────────────────────────────────────────────────

import { v } from "convex/values";
import { action, internalAction } from "../_generated/server";
import { internal } from "../_generated/api";
import { requireUser } from "../lib/auth";
import { withRefreshOn401 } from "../oauth/tokenManager";
import { preprocessEmailBody } from "../lib/emailPreprocess";
import type { ActionCtx } from "../_generated/server";
import type { Id } from "../_generated/dataModel";

// ─── Gmail payload helpers (small, self-contained copies of the helpers in
//     gmail.ts so this file doesn't have to import a "use node" sibling). ────

interface GmailHeader {
  name?: string;
  value?: string;
}

interface GmailPayload {
  mimeType?: string;
  filename?: string;
  headers?: GmailHeader[];
  body?: { data?: string; size?: number; attachmentId?: string };
  parts?: GmailPayload[];
}

interface GmailMessageResponse {
  id?: string;
  snippet?: string;
  payload?: GmailPayload;
}

function decodeBase64Url(b64url: string): string {
  const padded =
    b64url.replace(/-/g, "+").replace(/_/g, "/") +
    "=".repeat((4 - (b64url.length % 4)) % 4);
  const bin = atob(padded);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new TextDecoder("utf-8").decode(bytes);
}

function getBody(payload: GmailPayload): { text: string; html: string } {
  let text = "";
  let html = "";
  if (payload.mimeType === "text/plain" && payload.body?.data) {
    text = decodeBase64Url(payload.body.data);
  } else if (payload.mimeType === "text/html" && payload.body?.data) {
    html = decodeBase64Url(payload.body.data);
  }
  if (payload.parts) {
    for (const part of payload.parts) {
      const sub = getBody(part);
      if (sub.text && !text) text = sub.text;
      if (sub.html && !html) html = sub.html;
    }
  }
  return { text, html };
}

interface ParsedAttachment {
  filename: string;
  mimeType: string;
  size: number;
  providerAttachmentId?: string;
  contentId?: string;
}

function getAttachments(
  payload: GmailPayload,
  out: ParsedAttachment[] = [],
): ParsedAttachment[] {
  const cidHeader = payload.headers?.find(
    (h) => h.name?.toLowerCase() === "content-id",
  );
  const hasFilename = payload.filename && payload.filename.length > 0;
  const hasCid = !!cidHeader?.value;
  if ((hasFilename || hasCid) && payload.body?.attachmentId) {
    const contentId = cidHeader?.value?.replace(/[<>]/g, "");
    const mimeType = payload.mimeType || "application/octet-stream";
    out.push({
      filename:
        payload.filename ||
        `inline-${contentId || payload.body.attachmentId}.${
          mimeType.split("/")[1] || "bin"
        }`,
      mimeType,
      size: payload.body.size ?? 0,
      providerAttachmentId: payload.body.attachmentId,
      contentId: contentId ?? undefined,
    });
  }
  if (payload.parts) {
    for (const part of payload.parts) getAttachments(part, out);
  }
  return out;
}

// ─── Graph helpers ──────────────────────────────────────────────────────────

const GRAPH_BASE = "https://graph.microsoft.com/v1.0";

async function graphGet<T>(url: string, accessToken: string): Promise<T> {
  const fullUrl = url.startsWith("http") ? url : `${GRAPH_BASE}${url}`;
  const res = await fetch(fullUrl, {
    headers: {
      Authorization: `Bearer ${accessToken}`,
      Accept: "application/json",
    },
  });
  if (!res.ok) {
    const text = await res.text();
    const err = new Error(
      `Graph ${res.status}: ${text.slice(0, 300)}`,
    ) as Error & { status: number };
    err.status = res.status;
    throw err;
  }
  return (await res.json()) as T;
}

async function gmailGet<T>(url: string, accessToken: string): Promise<T> {
  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (!res.ok) {
    const text = await res.text();
    const err = new Error(
      `Gmail ${res.status}: ${text.slice(0, 300)}`,
    ) as Error & { status: number };
    err.status = res.status;
    throw err;
  }
  return (await res.json()) as T;
}

// ─── Provider fetch + persist ───────────────────────────────────────────────

async function fetchAndPersistGmailBody(
  ctx: ActionCtx,
  args: {
    emailId: Id<"emails">;
    accountId: Id<"mailAccounts">;
    providerMessageId: string;
    subject: string;
    // textOnly: store only the searchable text (historical backfill), not the
    // display HTML — old mail becomes searchable without re-inflating storage.
    textOnly?: boolean;
  },
) {
  const msg = await withRefreshOn401(ctx, args.accountId, async (token) =>
    gmailGet<GmailMessageResponse>(
      `https://gmail.googleapis.com/gmail/v1/users/me/messages/${encodeURIComponent(
        args.providerMessageId,
      )}?format=full`,
      token,
    ),
  );

  const body = msg.payload ? getBody(msg.payload) : { text: "", html: "" };

  if (args.textOnly) {
    await ctx.runMutation(
      internal.sync.onDemandBodyData._persistSearchTextOnly,
      {
        emailId: args.emailId,
        bodyText: body.text || undefined,
        bodyHtml: body.html || undefined,
      },
    );
    return;
  }

  const attachments = msg.payload ? getAttachments(msg.payload) : [];
  const pre = preprocessEmailBody(
    body.html || undefined,
    body.text || undefined,
    args.subject,
  );

  await ctx.runMutation(internal.sync.onDemandBodyData._persistBody, {
    emailId: args.emailId,
    bodyText: body.text || undefined,
    bodyHtml: body.html || undefined,
    hasQuotedHistory: pre.hasQuotedHistory,
    isForwarded: pre.isForwarded,
    hasAttachments: attachments.length > 0,
  });
  if (attachments.length > 0) {
    await ctx.runMutation(
      internal.sync.onDemandBodyData._persistAttachments,
      { emailId: args.emailId, attachments },
    );
  }
}

interface GraphMessageDetail {
  body?: { contentType?: string; content?: string };
  hasAttachments?: boolean;
}

interface GraphAttachmentList {
  value?: Array<{
    id: string;
    name?: string;
    contentType?: string;
    size?: number;
    isInline?: boolean;
    contentId?: string;
  }>;
}

async function fetchAndPersistMicrosoftBody(
  ctx: ActionCtx,
  args: {
    emailId: Id<"emails">;
    accountId: Id<"mailAccounts">;
    providerMessageId: string;
    subject: string;
    textOnly?: boolean;
  },
) {
  const detail = await withRefreshOn401(ctx, args.accountId, async (token) =>
    graphGet<GraphMessageDetail>(
      `/me/messages/${encodeURIComponent(args.providerMessageId)}?$select=body,hasAttachments`,
      token,
    ),
  );

  const bodyHtml =
    detail.body?.contentType?.toLowerCase() === "html"
      ? detail.body.content
      : undefined;
  const bodyText =
    detail.body?.contentType?.toLowerCase() === "text"
      ? detail.body.content
      : undefined;

  if (args.textOnly) {
    await ctx.runMutation(
      internal.sync.onDemandBodyData._persistSearchTextOnly,
      { emailId: args.emailId, bodyText, bodyHtml },
    );
    return;
  }

  const pre = preprocessEmailBody(bodyHtml, bodyText, args.subject);

  // Fetch attachment metadata when present. Failure is non-fatal — the body
  // is still useful even if attachment listing fails.
  let attachments: ParsedAttachment[] = [];
  if (detail.hasAttachments) {
    try {
      const attRes = await withRefreshOn401(
        ctx,
        args.accountId,
        async (token) =>
          graphGet<GraphAttachmentList>(
            `/me/messages/${encodeURIComponent(args.providerMessageId)}/attachments?$select=id,name,contentType,size,isInline,contentId`,
            token,
          ),
      );
      attachments = (attRes.value ?? []).map((att) => ({
        filename: att.name || "attachment",
        mimeType: att.contentType || "application/octet-stream",
        size: att.size ?? 0,
        providerAttachmentId: att.id,
        contentId: att.isInline ? att.contentId ?? undefined : undefined,
      }));
    } catch (err) {
      console.warn("[onDemandBody] graph attachment list failed:", err);
    }
  }

  await ctx.runMutation(internal.sync.onDemandBodyData._persistBody, {
    emailId: args.emailId,
    bodyText,
    bodyHtml,
    hasQuotedHistory: pre.hasQuotedHistory,
    isForwarded: pre.isForwarded,
    hasAttachments: !!detail.hasAttachments,
  });
  if (attachments.length > 0) {
    await ctx.runMutation(
      internal.sync.onDemandBodyData._persistAttachments,
      { emailId: args.emailId, attachments },
    );
  }
}

// ─── Public action ──────────────────────────────────────────────────────────
//
// `ensureEmailBody({ emailId })`:
//   - Returns { status: "already_present" } if a body row already exists.
//   - Otherwise fetches from the right provider, persists, and returns
//     { status: "fetched" }.
//   - Throws on auth/ownership errors (the frontend should not retry blindly).
// ─────────────────────────────────────────────────────────────────────────────

// Internal twin of ensureEmailBody, callable from the sync workers (which run
// as the system, with no logged-in user). Scheduled for each genuinely-new
// email the moment it's synced, so new mail arrives WITH its body — no manual
// "Re-fetch from Gmail" click. Idempotent: no-ops if a body already exists.
// Only fires for new emails (not label/read changes), so there's no re-write
// churn on an active mailbox.
export const fetchBodyForNewEmail = internalAction({
  args: { emailId: v.id("emails") },
  handler: async (ctx, { emailId }) => {
    const lookup = await ctx.runQuery(
      internal.sync.onDemandBodyData._lookupForBodyFetch,
      { emailId },
    );
    if (!lookup || lookup.hasBody) return;
    const subject = lookup.email.subject;
    if (lookup.account.provider === "GMAIL") {
      await fetchAndPersistGmailBody(ctx, {
        emailId,
        accountId: lookup.email.accountId,
        providerMessageId: lookup.email.providerMessageId,
        subject,
      });
    } else if (lookup.account.provider === "MICROSOFT") {
      await fetchAndPersistMicrosoftBody(ctx, {
        emailId,
        accountId: lookup.email.accountId,
        providerMessageId: lookup.email.providerMessageId,
        subject,
      });
    }
  },
});

// One-time backfill: pre-fetch bodies for recent mail so the active inbox
// opens instantly (no on-open spinner) without re-fetching the entire mailbox
// (which would blow the I/O budget). Paginates each active account's last
// `sinceDays` of mail, scheduling fetchBodyForNewEmail per message staggered
// to stay well under Gmail/Graph rate limits. Self-reschedules across pages
// and accounts. Kick off with:
//   npx convex run sync/onDemandBody:backfillRecentBodies '{"sinceDays":30}'
const BACKFILL_PAGE = 80;
const BACKFILL_STAGGER_MS = 300;

export const backfillRecentBodies = internalAction({
  args: {
    sinceDays: v.number(),
    accountIdx: v.optional(v.number()),
    beforeReceivedAt: v.optional(v.number()),
  },
  handler: async (ctx, { sinceDays, accountIdx = 0, beforeReceivedAt }) => {
    const accounts = (await ctx.runQuery(
      internal.sync.onDemandBodyData._listActiveAccountIds,
      {},
    )) as Array<{ _id: Id<"mailAccounts"> }>;
    if (accountIdx >= accounts.length) return { done: true };

    const account = accounts[accountIdx];
    const cutoffMs = Date.now() - sinceDays * 86_400_000;
    const page = (await ctx.runQuery(
      internal.sync.onDemandBodyData._recentEmailIdsPage,
      {
        accountId: account._id,
        cutoffMs,
        beforeReceivedAt,
        limit: BACKFILL_PAGE,
      },
    )) as { ids: Id<"emails">[]; lastReceivedAt?: number; full: boolean };

    // Stagger the per-message fetches so we don't burst the provider API.
    for (let i = 0; i < page.ids.length; i++) {
      await ctx.scheduler.runAfter(
        i * BACKFILL_STAGGER_MS,
        internal.sync.onDemandBody.fetchBodyForNewEmail,
        { emailId: page.ids[i] },
      );
    }

    if (page.full && page.lastReceivedAt !== undefined) {
      // More mail in this account — continue after this page drains.
      await ctx.scheduler.runAfter(
        BACKFILL_PAGE * BACKFILL_STAGGER_MS + 2_000,
        internal.sync.onDemandBody.backfillRecentBodies,
        { sinceDays, accountIdx, beforeReceivedAt: page.lastReceivedAt },
      );
    } else {
      // Account done — move to the next one.
      await ctx.scheduler.runAfter(
        5_000,
        internal.sync.onDemandBody.backfillRecentBodies,
        { sinceDays, accountIdx: accountIdx + 1 },
      );
    }
    return { account: account._id, scheduled: page.ids.length };
  },
});

// Text-only sibling of fetchBodyForNewEmail, used by the historical search
// backfill: pulls the message from the provider and stores ONLY its search
// text (no display HTML, no attachments). Idempotent.
export const fetchSearchTextForEmail = internalAction({
  args: { emailId: v.id("emails") },
  handler: async (ctx, { emailId }) => {
    const lookup = await ctx.runQuery(
      internal.sync.onDemandBodyData._lookupForBodyFetch,
      { emailId },
    );
    if (!lookup) return;
    const common = {
      emailId,
      accountId: lookup.email.accountId,
      providerMessageId: lookup.email.providerMessageId,
      subject: lookup.email.subject,
      textOnly: true,
    };
    if (lookup.account.provider === "GMAIL") {
      await fetchAndPersistGmailBody(ctx, common);
    } else if (lookup.account.provider === "MICROSOFT") {
      await fetchAndPersistMicrosoftBody(ctx, common);
    }
  },
});

// One-time historical backfill: make EVERY email in the mailbox searchable
// word-for-word by fetching text for messages that have no emailSearchText
// row. Run storageSweep first (it covers everything with a locally-stored
// body for free); this handles the rest via throttled provider fetches.
// ~50k messages at 300ms stagger ≈ a few hours, well under provider quotas.
// Kick off with:
//   npx convex run sync/onDemandBody:backfillSearchText '{}'
export const backfillSearchText = internalAction({
  args: {
    accountIdx: v.optional(v.number()),
    beforeReceivedAt: v.optional(v.number()),
  },
  handler: async (ctx, { accountIdx = 0, beforeReceivedAt }) => {
    const accounts = (await ctx.runQuery(
      internal.sync.onDemandBodyData._listActiveAccountIds,
      {},
    )) as Array<{ _id: Id<"mailAccounts"> }>;
    if (accountIdx >= accounts.length) return { done: true };

    const account = accounts[accountIdx];
    const page = (await ctx.runQuery(
      internal.sync.onDemandBodyData._searchlessEmailIdsPage,
      {
        accountId: account._id,
        beforeReceivedAt,
        limit: BACKFILL_PAGE,
      },
    )) as { ids: Id<"emails">[]; lastReceivedAt?: number; full: boolean };

    for (let i = 0; i < page.ids.length; i++) {
      await ctx.scheduler.runAfter(
        i * BACKFILL_STAGGER_MS,
        internal.sync.onDemandBody.fetchSearchTextForEmail,
        { emailId: page.ids[i] },
      );
    }

    if (page.full && page.lastReceivedAt !== undefined) {
      await ctx.scheduler.runAfter(
        BACKFILL_PAGE * BACKFILL_STAGGER_MS + 2_000,
        internal.sync.onDemandBody.backfillSearchText,
        { accountIdx, beforeReceivedAt: page.lastReceivedAt },
      );
    } else {
      await ctx.scheduler.runAfter(
        5_000,
        internal.sync.onDemandBody.backfillSearchText,
        { accountIdx: accountIdx + 1 },
      );
    }
    return { account: account._id, scheduled: page.ids.length };
  },
});

export const ensureEmailBody = action({
  args: { emailId: v.id("emails") },
  returns: v.object({
    status: v.union(v.literal("already_present"), v.literal("fetched")),
  }),
  handler: async (ctx, { emailId }) => {
    const userId = await requireUser(ctx);
    const lookup = await ctx.runQuery(
      internal.sync.onDemandBodyData._lookupForBodyFetch,
      { emailId },
    );
    if (!lookup) throw new Error("Email not found");
    if (lookup.account.userId !== userId) {
      throw new Error("Email not found");
    }
    if (lookup.hasBody) {
      return { status: "already_present" as const };
    }

    // `subject` is only used by preprocessEmailBody as a hint for
    // is-forwarded detection; the subject is already on the email row from
    // the metadata-only sync pass. Pass it through.
    const subject = lookup.email.subject;

    if (lookup.account.provider === "GMAIL") {
      await fetchAndPersistGmailBody(ctx, {
        emailId,
        accountId: lookup.email.accountId,
        providerMessageId: lookup.email.providerMessageId,
        subject,
      });
      return { status: "fetched" as const };
    }
    if (lookup.account.provider === "MICROSOFT") {
      await fetchAndPersistMicrosoftBody(ctx, {
        emailId,
        accountId: lookup.email.accountId,
        providerMessageId: lookup.email.providerMessageId,
        subject,
      });
      return { status: "fetched" as const };
    }
    throw new Error(`Unsupported provider: ${lookup.account.provider}`);
  },
});
