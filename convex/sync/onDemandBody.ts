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
import { action } from "../_generated/server";
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
    bodyHtmlClean: pre.bodyHtmlClean,
    bodyHtmlTrimmed: pre.bodyHtmlTrimmed,
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
    bodyHtmlClean: pre.bodyHtmlClean,
    bodyHtmlTrimmed: pre.bodyHtmlTrimmed,
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
