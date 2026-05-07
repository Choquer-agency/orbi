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
import { encrypt } from "./tokenManager";

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
