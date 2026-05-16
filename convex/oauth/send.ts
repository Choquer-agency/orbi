"use node";

import { internalAction } from "../_generated/server";
import { v } from "convex/values";
import type { Id } from "../_generated/dataModel";
import { withRefreshOn401 } from "./tokenManager";

const recipient = v.object({ email: v.string(), name: v.optional(v.string()) });

const messageArg = v.object({
  to: v.array(recipient),
  cc: v.optional(v.array(recipient)),
  bcc: v.optional(v.array(recipient)),
  subject: v.string(),
  bodyHtml: v.string(),
  bodyText: v.string(),
  inReplyTo: v.optional(v.string()),
  references: v.optional(v.array(v.string())),
  // Gmail's internal thread id (provider thread id). When set, Gmail glues
  // the new message into the existing conversation. Without it Gmail
  // creates a brand-new thread even if Subject + headers match.
  providerThreadId: v.optional(v.string()),
  emailId: v.id("emails"),
});

function encodeHeader(value: string): string {
  return value.replace(/[\r\n]/g, " ");
}

function formatRecipient(r: { email: string; name?: string }): string {
  const email = encodeHeader(r.email);
  const name = r.name ? encodeHeader(r.name).replace(/"/g, '\\"') : "";
  return name ? `"${name}" <${email}>` : email;
}

function base64Url(input: string): string {
  return Buffer.from(input, "utf8")
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

function htmlToText(html: string): string {
  return html
    .replace(/<br\s*\/?>(\s*)/gi, "\n")
    .replace(/<\/p>\s*<p[^>]*>/gi, "\n\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .trim();
}

function buildRawEmail(message: {
  to: Array<{ email: string; name?: string }>;
  cc?: Array<{ email: string; name?: string }>;
  bcc?: Array<{ email: string; name?: string }>;
  subject: string;
  bodyHtml: string;
  bodyText: string;
  inReplyTo?: string;
  references?: string[];
}) {
  const boundary = `orbi-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const headers = [
    `To: ${message.to.map(formatRecipient).join(", ")}`,
    ...(message.cc?.length ? [`Cc: ${message.cc.map(formatRecipient).join(", ")}`] : []),
    ...(message.bcc?.length ? [`Bcc: ${message.bcc.map(formatRecipient).join(", ")}`] : []),
    `Subject: ${encodeHeader(message.subject)}`,
    "MIME-Version: 1.0",
    `Content-Type: multipart/alternative; boundary="${boundary}"`,
  ];
  if (message.inReplyTo) {
    headers.push(`In-Reply-To: ${encodeHeader(message.inReplyTo)}`);
    // Full References chain per RFC 5322: every prior message-id plus the
    // immediate parent. Falls back to just inReplyTo when chain is missing.
    const refs =
      message.references && message.references.length > 0
        ? message.references
        : [message.inReplyTo];
    headers.push(`References: ${refs.map(encodeHeader).join(" ")}`);
  }

  const bodyText = message.bodyText || htmlToText(message.bodyHtml);
  return [
    ...headers,
    "",
    `--${boundary}`,
    "Content-Type: text/plain; charset=UTF-8",
    "Content-Transfer-Encoding: 8bit",
    "",
    bodyText,
    `--${boundary}`,
    "Content-Type: text/html; charset=UTF-8",
    "Content-Transfer-Encoding: 8bit",
    "",
    message.bodyHtml || `<p>${bodyText.replace(/\n/g, "<br/>")}</p>`,
    `--${boundary}--`,
    "",
  ].join("\r\n");
}

export const sendGmail = internalAction({
  args: { accountId: v.id("mailAccounts"), message: messageArg },
  handler: async (ctx, { accountId, message }): Promise<{ providerMessageId?: string }> => {
    const raw = base64Url(buildRawEmail(message));
    return await withRefreshOn401(ctx, accountId as Id<"mailAccounts">, async (token) => {
      // Gmail glues the new message into an existing conversation when we
      // pass `threadId` in the request body. This is what fixes "reply
      // showed up as a brand-new thread with the same subject".
      const requestBody: { raw: string; threadId?: string } = { raw };
      if (message.providerThreadId) requestBody.threadId = message.providerThreadId;
      const res = await fetch("https://gmail.googleapis.com/gmail/v1/users/me/messages/send", {
        method: "POST",
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        body: JSON.stringify(requestBody),
      });
      if (!res.ok) {
        const text = await res.text();
        const err = new Error(`Gmail send failed (${res.status}): ${text.slice(0, 500)}`) as Error & { status: number };
        err.status = res.status;
        throw err;
      }
      const json = (await res.json()) as { id?: string };
      return { providerMessageId: json.id };
    });
  },
});

function graphRecipients(recipients: Array<{ email: string; name?: string }> | undefined) {
  return (recipients ?? []).map((r) => ({
    emailAddress: { address: r.email, ...(r.name ? { name: r.name } : {}) },
  }));
}

export const sendMicrosoft = internalAction({
  args: { accountId: v.id("mailAccounts"), message: messageArg },
  handler: async (ctx, { accountId, message }): Promise<{ providerMessageId?: string }> => {
    await withRefreshOn401(ctx, accountId as Id<"mailAccounts">, async (token) => {
      // Build full In-Reply-To + References headers so Outlook / Exchange
      // attach this message to the existing conversation. Microsoft Graph's
      // sendMail accepts custom internetMessageHeaders; with both headers
      // present the server matches conversationId on the receiving side.
      const replyHeaders: Array<{ name: string; value: string }> = [];
      if (message.inReplyTo) {
        replyHeaders.push({ name: "In-Reply-To", value: message.inReplyTo });
        const refs =
          message.references && message.references.length > 0
            ? message.references
            : [message.inReplyTo];
        replyHeaders.push({ name: "References", value: refs.join(" ") });
      }
      const res = await fetch("https://graph.microsoft.com/v1.0/me/sendMail", {
        method: "POST",
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        body: JSON.stringify({
          message: {
            subject: message.subject,
            body: { contentType: "HTML", content: message.bodyHtml || `<p>${message.bodyText}</p>` },
            toRecipients: graphRecipients(message.to),
            ccRecipients: graphRecipients(message.cc),
            bccRecipients: graphRecipients(message.bcc),
            ...(replyHeaders.length > 0
              ? { internetMessageHeaders: replyHeaders }
              : {}),
          },
          saveToSentItems: true,
        }),
      });
      if (!res.ok) {
        const text = await res.text();
        const err = new Error(`Microsoft send failed (${res.status}): ${text.slice(0, 500)}`) as Error & { status: number };
        err.status = res.status;
        throw err;
      }
    });
    return {};
  },
});
