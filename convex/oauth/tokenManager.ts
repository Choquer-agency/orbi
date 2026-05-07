// ─────────────────────────────────────────────────────────────────────────────
// tokenManager.ts — OAuth token encryption + refresh logic.
// Uses Web Crypto API (works in both Convex runtimes; no "use node" needed).
// AES-256-GCM with TOKEN_ENCRYPTION_KEY (hex). Format: `iv:ciphertextWithTag` (base64).
// (Auth tag is appended to ciphertext by Web Crypto — different from Node's
//  three-part format, but we're starting fresh with Convex so no migration.)
// ─────────────────────────────────────────────────────────────────────────────

import { internalAction } from "../_generated/server";
import { internal } from "../_generated/api";
import { v } from "convex/values";
import type { ActionCtx } from "../_generated/server";
import type { Id } from "../_generated/dataModel";

const IV_LENGTH = 12; // recommended for AES-GCM

function hexToBytes(hex: string): Uint8Array {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.substr(i * 2, 2), 16);
  return out;
}

function bytesToBase64(bytes: Uint8Array): string {
  let s = "";
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
  return btoa(s);
}

function base64ToBytes(b64: string): Uint8Array {
  const s = atob(b64);
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
  return out;
}

async function getKey(): Promise<CryptoKey> {
  const keyHex = process.env.TOKEN_ENCRYPTION_KEY;
  if (!keyHex) throw new Error("TOKEN_ENCRYPTION_KEY env var is required");
  return await crypto.subtle.importKey(
    "raw",
    hexToBytes(keyHex) as BufferSource,
    { name: "AES-GCM" },
    false,
    ["encrypt", "decrypt"],
  );
}

export async function encrypt(text: string): Promise<string> {
  const key = await getKey();
  const iv = crypto.getRandomValues(new Uint8Array(IV_LENGTH));
  const ct = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv: iv as BufferSource },
    key,
    new TextEncoder().encode(text) as BufferSource,
  );
  return `${bytesToBase64(iv)}:${bytesToBase64(new Uint8Array(ct))}`;
}

export async function decrypt(encryptedText: string): Promise<string> {
  const [ivB64, ctB64] = encryptedText.split(":");
  const key = await getKey();
  const pt = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: base64ToBytes(ivB64) as BufferSource },
    key,
    base64ToBytes(ctB64) as BufferSource,
  );
  return new TextDecoder().decode(pt);
}

// `persistRefreshedToken` lives in tokenStore.ts (V8 runtime) since this file
// is "use node" and mutations aren't allowed in the node runtime. Refresh
// actions call: `ctx.runMutation(internal.oauth.tokenStore.persistRefreshedToken, ...)`.

// ─────────────────────────────────────────────────────────────────────────────
// Returns a valid (non-expired) access token for an account, refreshing
// through the provider if needed. Callable from any action that needs to
// hit Gmail / Microsoft Graph on behalf of the user.
// ─────────────────────────────────────────────────────────────────────────────
export async function getValidAccessToken(
  ctx: ActionCtx,
  accountId: Id<"mailAccounts">,
): Promise<string> {
  const account = await ctx.runQuery(internal.mailAccounts._getAccountForToken, {
    accountId,
  });
  if (!account) throw new Error(`Account not found: ${accountId}`);

  // 5-minute buffer matches backend behavior.
  const now = Date.now();
  if (account.tokenExpiry && account.tokenExpiry > now + 5 * 60 * 1000) {
    return await decrypt(account.accessToken);
  }

  if (!account.refreshToken) {
    throw new Error(`No refresh token available for account ${accountId}`);
  }
  const refreshToken = await decrypt(account.refreshToken);

  if (account.provider === "GMAIL") {
    return await ctx.runAction(internal.oauth.gmail.refreshToken, {
      accountId,
      refreshToken,
    });
  }
  if (account.provider === "MICROSOFT") {
    return await ctx.runAction(internal.oauth.microsoft.refreshToken, {
      accountId,
      refreshToken,
    });
  }
  throw new Error(`Token refresh not supported for provider ${account.provider}`);
}

// ─────────────────────────────────────────────────────────────────────────────
// `withRefreshOn401(ctx, accountId, fn)` — wrapper used by sync/send.
// On the first 401 from the provider, refresh the access token and retry once.
// ─────────────────────────────────────────────────────────────────────────────
export async function withRefreshOn401<T>(
  ctx: ActionCtx,
  accountId: Id<"mailAccounts">,
  fn: (accessToken: string) => Promise<T>,
): Promise<T> {
  let token = await getValidAccessToken(ctx, accountId);
  try {
    return await fn(token);
  } catch (err: unknown) {
    const isUnauthorized =
      typeof err === "object" &&
      err !== null &&
      "status" in err &&
      (err as { status?: number }).status === 401;
    if (!isUnauthorized) throw err;

    // Force a refresh by clearing the cached expiry path: just re-fetch.
    token = await getValidAccessToken(ctx, accountId);
    return await fn(token);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Convenience action wrapper so other Convex actions can call this via
// ctx.runAction when they're not already in Node-runtime actions themselves.
// ─────────────────────────────────────────────────────────────────────────────
export const getAccessToken = internalAction({
  args: { accountId: v.id("mailAccounts") },
  handler: async (ctx, { accountId }) => {
    return await getValidAccessToken(ctx, accountId);
  },
});
