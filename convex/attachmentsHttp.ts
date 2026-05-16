import { httpAction } from "./_generated/server";
import { internal } from "./_generated/api";
import { getAuthUserId } from "@convex-dev/auth/server";
import type { HttpRouter } from "convex/server";

function base64ToBytes(base64: string): Uint8Array {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

function corsHeaders(req: Request): Record<string, string> {
  const origin = req.headers.get("Origin") || "*";
  return {
    "Access-Control-Allow-Origin": origin,
    "Access-Control-Allow-Methods": "GET, OPTIONS",
    "Access-Control-Allow-Headers": "Authorization, Content-Type",
    "Access-Control-Allow-Credentials": "true",
    "Vary": "Origin",
  };
}

const inlineAttachmentOptionsHandler = httpAction(async (_ctx, req) => {
  return new Response(null, { status: 204, headers: corsHeaders(req) });
});

const inlineAttachmentHandler = httpAction(async (ctx, req) => {
  const cors = corsHeaders(req);
  const userId = await getAuthUserId(ctx);
  if (!userId) return new Response("Unauthorized", { status: 401, headers: cors });

  const url = new URL(req.url);
  const match = url.pathname.match(/^\/api\/attachments\/inline\/([^/]+)$/);
  const attachmentId = match?.[1];
  if (!attachmentId) return new Response("Not found", { status: 404, headers: cors });

  const loaded = await ctx.runQuery(internal.emails._getAttachmentForHttp, {
    userId,
    attachmentId: attachmentId as any,
  });
  if (!loaded) return new Response("Not found", { status: 404, headers: cors });

  if (loaded.attachment.storageId) {
    const blob = await ctx.storage.get(loaded.attachment.storageId);
    if (!blob) return new Response("Not found", { status: 404, headers: cors });
    return new Response(blob, {
      status: 200,
      headers: {
        ...cors,
        "Content-Type": loaded.attachment.mimeType || blob.type || "application/octet-stream",
        "Cache-Control": "private, max-age=3600",
        "Content-Disposition": `inline; filename="${loaded.attachment.filename.replace(/"/g, "")}"`,
      },
    });
  }

  if (!loaded.attachment.providerAttachmentId) {
    return new Response("Attachment body unavailable", { status: 404, headers: cors });
  }

  const fetched = await ctx.runAction(internal.oauth.attachments.fetchProviderAttachment, {
    accountId: loaded.account._id,
    provider: loaded.account.provider,
    providerMessageId: loaded.email.providerMessageId,
    providerAttachmentId: loaded.attachment.providerAttachmentId,
    mimeType: loaded.attachment.mimeType,
  });

  if (!fetched.base64) return new Response("Attachment body unavailable", { status: 404, headers: cors });

  const bytes = base64ToBytes(fetched.base64);
  const body = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(body).set(bytes);
  return new Response(body, {
    status: 200,
    headers: {
      ...cors,
      "Content-Type": fetched.mimeType || loaded.attachment.mimeType || "application/octet-stream",
      "Cache-Control": "private, max-age=3600",
      "Content-Disposition": `inline; filename="${loaded.attachment.filename.replace(/"/g, "")}"`,
    },
  });
});

export function addAttachmentHttpRoutes(http: HttpRouter) {
  http.route({
    pathPrefix: "/api/attachments/inline/",
    method: "OPTIONS",
    handler: inlineAttachmentOptionsHandler,
  });
  http.route({
    pathPrefix: "/api/attachments/inline/",
    method: "GET",
    handler: inlineAttachmentHandler,
  });
}
