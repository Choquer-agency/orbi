"use node";

// ─────────────────────────────────────────────────────────────────────────────
// Gmail OAuth — ported from packages/backend/src/services/oauth/gmail-oauth.ts
//
// Differences from the Fastify version:
//   - State is signed by Convex Auth's existing signer, but here we keep it
//     simple: state = userId (the action verifies the caller is signed in
//     before issuing the URL, then the callback runs an internal mutation
//     keyed by that userId). For desktop/web differentiation we encode
//     `userId|platform` separated by `|`.
//   - We use `fetch` against Google's REST endpoints instead of the
//     `googleapis` SDK so the action is lighter. Same scopes, same flow.
// ─────────────────────────────────────────────────────────────────────────────

import { internalAction } from "../_generated/server";
import { internal } from "../_generated/api";
import { v } from "convex/values";
import type { Id } from "../_generated/dataModel";
import { encrypt, withRefreshOn401 } from "./tokenManager";

const SCOPES = [
  "https://www.googleapis.com/auth/gmail.readonly",
  "https://www.googleapis.com/auth/gmail.send",
  "https://www.googleapis.com/auth/gmail.modify",
  "https://www.googleapis.com/auth/userinfo.email",
  "https://www.googleapis.com/auth/userinfo.profile",
];

const AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth";
const TOKEN_URL = "https://oauth2.googleapis.com/token";
const USERINFO_URL = "https://www.googleapis.com/oauth2/v2/userinfo";

function clientId(): string {
  const v = process.env.GOOGLE_CLIENT_ID;
  if (!v) throw new Error("GOOGLE_CLIENT_ID is not configured");
  return v;
}
function clientSecret(): string {
  const v = process.env.GOOGLE_CLIENT_SECRET;
  if (!v) throw new Error("GOOGLE_CLIENT_SECRET is not configured");
  return v;
}
function redirectUri(): string {
  return (
    process.env.GOOGLE_REDIRECT_URI ||
    "http://localhost:3001/api/accounts/oauth/gmail/callback"
  );
}

export function buildAuthUrl(state: string): string {
  const params = new URLSearchParams({
    client_id: clientId(),
    redirect_uri: redirectUri(),
    response_type: "code",
    access_type: "offline",
    prompt: "consent",
    scope: SCOPES.join(" "),
    state,
  });
  return `${AUTH_URL}?${params.toString()}`;
}

// ─────────────────────────────────────────────────────────────────────────────
// Exchange auth code for tokens, fetch profile, upsert mailAccount.
// Called by the HTTP callback handler in oauth/http.ts.
//
// `state` is encoded as `userId|platform`.
// ─────────────────────────────────────────────────────────────────────────────
export const exchangeCode = internalAction({
  args: {
    code: v.string(),
    state: v.string(),
  },
  handler: async (
    ctx,
    { code, state },
  ): Promise<{
    accountId: Id<"mailAccounts">;
    email: string;
    platform: string;
  }> => {
    const [userIdRaw, platformRaw] = state.split("|");
    const userId = userIdRaw as Id<"users">;
    const platform = platformRaw || "web";
    if (!userId) throw new Error("Invalid state parameter");

    // 1. Exchange code → tokens
    const tokenRes = await fetch(TOKEN_URL, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        code,
        client_id: clientId(),
        client_secret: clientSecret(),
        redirect_uri: redirectUri(),
        grant_type: "authorization_code",
      }).toString(),
    });
    if (!tokenRes.ok) {
      const txt = await tokenRes.text();
      throw new Error(`Gmail token exchange failed (${tokenRes.status}): ${txt}`);
    }
    const tokens = (await tokenRes.json()) as {
      access_token: string;
      refresh_token?: string;
      expires_in?: number;
      scope?: string;
      token_type?: string;
    };

    // 2. Fetch user profile
    const profileRes = await fetch(USERINFO_URL, {
      headers: { Authorization: `Bearer ${tokens.access_token}` },
    });
    if (!profileRes.ok) {
      const txt = await profileRes.text();
      throw new Error(`Gmail userinfo failed (${profileRes.status}): ${txt}`);
    }
    const profile = (await profileRes.json()) as {
      email: string;
      name?: string;
    };

    const tokenExpiry =
      typeof tokens.expires_in === "number"
        ? Date.now() + tokens.expires_in * 1000
        : undefined;

    // 3. Upsert mailAccount via internal mutation (encrypted at rest)
    const accountId: Id<"mailAccounts"> = await ctx.runMutation(
      internal.mailAccounts._upsertOAuthAccount,
      {
        userId,
        provider: "GMAIL",
        email: profile.email,
        displayName: profile.name,
        encryptedAccessToken: await encrypt(tokens.access_token),
        encryptedRefreshToken: tokens.refresh_token
          ? await encrypt(tokens.refresh_token)
          : undefined,
        tokenExpiry,
        scopes: SCOPES,
      },
    );

    return { accountId, email: profile.email, platform };
  },
});

// ─────────────────────────────────────────────────────────────────────────────
// Refresh access token using the stored refresh token. Persists the new
// encrypted access token + expiry, returns the plaintext access token to the
// caller (sync/send actions).
// ─────────────────────────────────────────────────────────────────────────────
export const refreshToken = internalAction({
  args: {
    accountId: v.id("mailAccounts"),
    refreshToken: v.string(),
  },
  handler: async (ctx, { accountId, refreshToken }): Promise<string> => {
    const res = await fetch(TOKEN_URL, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id: clientId(),
        client_secret: clientSecret(),
        refresh_token: refreshToken,
        grant_type: "refresh_token",
      }).toString(),
    });
    if (!res.ok) {
      const txt = await res.text();
      throw new Error(`Gmail token refresh failed (${res.status}): ${txt}`);
    }
    const json = (await res.json()) as {
      access_token: string;
      expires_in?: number;
    };

    const newAccessToken = json.access_token;
    const tokenExpiry =
      typeof json.expires_in === "number"
        ? Date.now() + json.expires_in * 1000
        : undefined;

    await ctx.runMutation(internal.oauth.tokenStore.persistRefreshedToken, {
      accountId,
      encryptedAccessToken: await encrypt(newAccessToken),
      tokenExpiry,
    });

    return newAccessToken;
  },
});

// ─────────────────────────────────────────────────────────────────────────────
// Send a message via the Gmail API. Builds an RFC 2822 MIME message
// (multipart/alternative for text+html, wrapped in multipart/mixed when
// attachments are present), POSTs it base64url-encoded, and returns the
// resulting Gmail message id.
// ─────────────────────────────────────────────────────────────────────────────

const recipient = v.object({
  email: v.string(),
  name: v.optional(v.string()),
});

function formatAddress(a: { email: string; name?: string }): string {
  if (a.name && a.name.trim().length > 0) {
    const safeName = a.name.replace(/"/g, '\\"');
    return `"${safeName}" <${a.email}>`;
  }
  return a.email;
}

function genBoundary(prefix: string): string {
  return `${prefix}_${Date.now().toString(36)}_${Math.random()
    .toString(36)
    .slice(2, 10)}`;
}

function chunkBase64(b64: string, lineLen = 76): string {
  const out: string[] = [];
  for (let i = 0; i < b64.length; i += lineLen) {
    out.push(b64.slice(i, i + lineLen));
  }
  return out.join("\r\n");
}

function encodeHeaderWord(s: string): string {
  // RFC 2047 — only encode if the string has non-ASCII; otherwise leave as is.
  if (/^[\x20-\x7E]*$/.test(s)) return s;
  const b64 = Buffer.from(s, "utf8").toString("base64");
  return `=?UTF-8?B?${b64}?=`;
}

function genMessageId(domain: string): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  let hex = "";
  for (let i = 0; i < bytes.length; i++) {
    hex += bytes[i].toString(16).padStart(2, "0");
  }
  return `<${hex}@${domain}>`;
}

// Decide whether an inReplyTo value looks like a real RFC 5322 Message-ID
// (contains '@') vs a Gmail REST API id (hex-only). We only thread off the
// former — using a Gmail REST id as In-Reply-To produces a header no other
// mail server understands, which then causes our own splitter to break the
// reply into a separate sub-thread on the next sync.
function isUsableMessageId(s: string | undefined): boolean {
  if (!s) return false;
  return s.includes("@");
}

async function buildRawMessage(opts: {
  from: { email: string; name?: string };
  to: Array<{ email: string; name?: string }>;
  cc: Array<{ email: string; name?: string }>;
  bcc: Array<{ email: string; name?: string }>;
  subject: string;
  bodyText: string;
  bodyHtml: string;
  inReplyTo?: string;
  messageId: string;
  attachments: Array<{ filename: string; mimeType: string; bytes: Uint8Array }>;
}): Promise<string> {
  const altBoundary = genBoundary("alt");
  const mixedBoundary = genBoundary("mixed");
  const hasAttachments = opts.attachments.length > 0;

  const headers: string[] = [
    `From: ${formatAddress(opts.from)}`,
    `To: ${opts.to.map(formatAddress).join(", ")}`,
  ];
  if (opts.cc.length > 0) {
    headers.push(`Cc: ${opts.cc.map(formatAddress).join(", ")}`);
  }
  if (opts.bcc.length > 0) {
    headers.push(`Bcc: ${opts.bcc.map(formatAddress).join(", ")}`);
  }
  headers.push(`Subject: ${encodeHeaderWord(opts.subject || "")}`);
  headers.push(`Message-ID: ${opts.messageId}`);
  if (isUsableMessageId(opts.inReplyTo)) {
    const ref = opts.inReplyTo!.startsWith("<")
      ? opts.inReplyTo!
      : `<${opts.inReplyTo!}>`;
    headers.push(`In-Reply-To: ${ref}`);
    headers.push(`References: ${ref}`);
  }
  headers.push("MIME-Version: 1.0");

  const textB64 = chunkBase64(
    Buffer.from(opts.bodyText || "", "utf8").toString("base64"),
  );
  const htmlB64 = chunkBase64(
    Buffer.from(opts.bodyHtml || "", "utf8").toString("base64"),
  );

  const altPart = [
    `--${altBoundary}`,
    "Content-Type: text/plain; charset=UTF-8",
    "Content-Transfer-Encoding: base64",
    "",
    textB64,
    "",
    `--${altBoundary}`,
    "Content-Type: text/html; charset=UTF-8",
    "Content-Transfer-Encoding: base64",
    "",
    htmlB64,
    "",
    `--${altBoundary}--`,
  ].join("\r\n");

  if (!hasAttachments) {
    headers.push(
      `Content-Type: multipart/alternative; boundary="${altBoundary}"`,
    );
    return [headers.join("\r\n"), "", altPart].join("\r\n");
  }

  headers.push(`Content-Type: multipart/mixed; boundary="${mixedBoundary}"`);
  const parts: string[] = [];
  parts.push(`--${mixedBoundary}`);
  parts.push(`Content-Type: multipart/alternative; boundary="${altBoundary}"`);
  parts.push("");
  parts.push(altPart);
  parts.push("");
  for (const att of opts.attachments) {
    const safeName = att.filename.replace(/"/g, "");
    const attB64 = chunkBase64(Buffer.from(att.bytes).toString("base64"));
    parts.push(`--${mixedBoundary}`);
    parts.push(`Content-Type: ${att.mimeType}; name="${safeName}"`);
    parts.push("Content-Transfer-Encoding: base64");
    parts.push(`Content-Disposition: attachment; filename="${safeName}"`);
    parts.push("");
    parts.push(attB64);
    parts.push("");
  }
  parts.push(`--${mixedBoundary}--`);

  return [headers.join("\r\n"), "", parts.join("\r\n")].join("\r\n");
}

export const send = internalAction({
  args: {
    accountId: v.id("mailAccounts"),
    message: v.object({
      to: v.array(recipient),
      cc: v.optional(v.array(recipient)),
      bcc: v.optional(v.array(recipient)),
      subject: v.string(),
      bodyHtml: v.string(),
      bodyText: v.string(),
      inReplyTo: v.optional(v.string()),
      emailId: v.id("emails"),
    }),
  },
  handler: async (
    ctx,
    { accountId, message },
  ): Promise<{
    providerMessageId: string | undefined;
    internetMessageId: string | undefined;
  }> => {
    // Load email + account so we know the from address and can resolve
    // attachments. Both are already stored on the email row by emails.send /
    // drafts.sendDraft, so we just read them back here.
    const ctxData = await ctx.runQuery(internal.emails._loadForSend, {
      emailId: message.emailId,
    });
    if (!ctxData) throw new Error("Email not found for send");
    const { email, account, thread } = ctxData;
    if (account.provider !== "GMAIL") {
      throw new Error(`Account is not a Gmail account: ${account.provider}`);
    }

    // Look up the parent thread's Gmail providerThreadId so we can ask Gmail
    // to keep this message in the same Gmail-side thread. When Bryce composes
    // a brand-new email the thread starts with `local-thread-…` — we skip
    // passing threadId in that case (Gmail will create a new thread on its
    // side, which is correct for a brand-new conversation).
    const gmailThreadId =
      thread &&
      !thread.providerThreadId.startsWith("local-thread-") &&
      !thread.providerThreadId.startsWith("draft-thread-")
        ? thread.providerThreadId
        : undefined;

    // Pull attachment bytes from Convex storage.
    const attachmentMeta = await ctx.runQuery(
      internal.emails._getAttachmentsForSend,
      { emailId: message.emailId },
    );
    const attachments: Array<{
      filename: string;
      mimeType: string;
      bytes: Uint8Array;
    }> = [];
    for (const a of attachmentMeta) {
      const blob = await ctx.storage.get(a.storageId);
      if (!blob) continue;
      const buf = await blob.arrayBuffer();
      attachments.push({
        filename: a.filename,
        mimeType: a.mimeType,
        bytes: new Uint8Array(buf),
      });
    }

    const fromName = email.fromName || account.displayName || undefined;
    const fromDomain =
      account.email.split("@")[1] || "mail.local";
    const messageId = genMessageId(fromDomain);
    const raw = await buildRawMessage({
      from: { email: account.email, name: fromName },
      to: message.to,
      cc: message.cc ?? [],
      bcc: message.bcc ?? [],
      subject: message.subject,
      bodyHtml: message.bodyHtml,
      bodyText: message.bodyText,
      inReplyTo: message.inReplyTo,
      messageId,
      attachments,
    });

    const rawB64Url = Buffer.from(raw, "utf8")
      .toString("base64")
      .replace(/\+/g, "-")
      .replace(/\//g, "_")
      .replace(/=+$/, "");

    let providerMessageId: string | undefined;
    await withRefreshOn401(ctx, accountId, async (token) => {
      const body: { raw: string; threadId?: string } = { raw: rawB64Url };
      if (gmailThreadId) body.threadId = gmailThreadId;
      const res = await fetch(
        "https://gmail.googleapis.com/gmail/v1/users/me/messages/send",
        {
          method: "POST",
          headers: {
            Authorization: `Bearer ${token}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify(body),
        },
      );
      if (!res.ok) {
        const text = await res.text();
        const err = new Error(
          `Gmail send failed (${res.status}): ${text.slice(0, 400)}`,
        ) as Error & { status: number };
        err.status = res.status;
        throw err;
      }
      const json = (await res.json()) as { id?: string };
      providerMessageId = json.id;
    });

    return { providerMessageId, internetMessageId: messageId };
  },
});

// ─────────────────────────────────────────────────────────────────────────────
// Pull every address the user can send-as from Gmail and stash them on the
// mailAccount as `aliases`. Used by reply-all to know which addresses are
// "self" so the user is never silently added back to their own To row when
// replying to a thread delivered to an inbox alias / forwarding address.
// ─────────────────────────────────────────────────────────────────────────────
export const refreshAliases = internalAction({
  args: { accountId: v.id("mailAccounts") },
  handler: async (ctx, { accountId }): Promise<{ aliases: string[] }> => {
    const aliases = await withRefreshOn401(ctx, accountId, async (token) => {
      const res = await fetch(
        "https://gmail.googleapis.com/gmail/v1/users/me/settings/sendAs",
        { headers: { Authorization: `Bearer ${token}` } },
      );
      if (!res.ok) {
        const text = await res.text();
        const err = new Error(
          `Gmail sendAs fetch failed (${res.status}): ${text.slice(0, 200)}`,
        ) as Error & { status: number };
        err.status = res.status;
        throw err;
      }
      const json = (await res.json()) as {
        sendAs?: Array<{ sendAsEmail?: string }>;
      };
      const list = (json.sendAs ?? [])
        .map((s) => (s.sendAsEmail ?? "").toLowerCase().trim())
        .filter((e) => e.length > 0 && e.includes("@"));
      return Array.from(new Set(list));
    });
    await ctx.runMutation(internal.mailAccounts._setAliases, {
      accountId,
      aliases,
    });
    return { aliases };
  },
});
