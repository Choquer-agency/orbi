import { internalAction } from "../_generated/server";
import { v } from "convex/values";
import { withRefreshOn401 } from "./tokenManager";

function base64UrlToBase64(input: string): string {
  const normalized = input.replace(/-/g, "+").replace(/_/g, "/");
  return normalized.padEnd(Math.ceil(normalized.length / 4) * 4, "=");
}

async function fetchOk(url: string, accessToken: string): Promise<Response> {
  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (!res.ok) {
    const error = new Error(`Provider attachment fetch failed: ${res.status}`) as Error & { status?: number };
    error.status = res.status;
    throw error;
  }
  return res;
}

export const fetchProviderAttachment = internalAction({
  args: {
    accountId: v.id("mailAccounts"),
    provider: v.union(v.literal("GMAIL"), v.literal("MICROSOFT"), v.literal("APPLE_IMAP")),
    providerMessageId: v.string(),
    providerAttachmentId: v.string(),
    mimeType: v.string(),
  },
  handler: async (ctx, args) => {
    if (args.provider === "GMAIL") {
      return await withRefreshOn401(ctx, args.accountId, async (accessToken) => {
        const res = await fetchOk(
          `https://gmail.googleapis.com/gmail/v1/users/me/messages/${encodeURIComponent(args.providerMessageId)}/attachments/${encodeURIComponent(args.providerAttachmentId)}`,
          accessToken,
        );
        const json = (await res.json()) as { data?: string };
        return {
          base64: json.data ? base64UrlToBase64(json.data) : "",
          mimeType: args.mimeType,
        };
      });
    }

    if (args.provider === "MICROSOFT") {
      return await withRefreshOn401(ctx, args.accountId, async (accessToken) => {
        const res = await fetchOk(
          `https://graph.microsoft.com/v1.0/me/messages/${encodeURIComponent(args.providerMessageId)}/attachments/${encodeURIComponent(args.providerAttachmentId)}`,
          accessToken,
        );
        const json = (await res.json()) as { contentBytes?: string; contentType?: string };
        return {
          base64: json.contentBytes || "",
          mimeType: json.contentType || args.mimeType,
        };
      });
    }

    throw new Error(`Provider attachments not supported for ${args.provider}`);
  },
});
