"use node";

// ─────────────────────────────────────────────────────────────────────────────
// Microsoft OAuth — ported from
// packages/backend/src/services/oauth/microsoft-oauth.ts
//
// Uses plain `fetch` against the Microsoft identity platform endpoints
// (no @azure/msal-node dependency in Convex).
// ─────────────────────────────────────────────────────────────────────────────

import { internalAction } from "../_generated/server";
import { internal } from "../_generated/api";
import { v } from "convex/values";
import type { Id } from "../_generated/dataModel";
import { encrypt } from "./tokenManager";

const SCOPES = ["Mail.ReadWrite", "Mail.Send", "User.Read", "offline_access"];

function clientId(): string {
  const v = process.env.MICROSOFT_CLIENT_ID;
  if (!v) throw new Error("MICROSOFT_CLIENT_ID is not configured");
  return v;
}
function clientSecret(): string {
  const v = process.env.MICROSOFT_CLIENT_SECRET;
  if (!v) throw new Error("MICROSOFT_CLIENT_SECRET is not configured");
  return v;
}
function tenantId(): string {
  return process.env.MICROSOFT_TENANT_ID || "common";
}
function redirectUri(): string {
  return (
    process.env.MICROSOFT_REDIRECT_URI ||
    "http://localhost:3001/api/accounts/oauth/microsoft/callback"
  );
}
function authBase(): string {
  return `https://login.microsoftonline.com/${tenantId()}/oauth2/v2.0`;
}

export function buildAuthUrl(state: string): string {
  const params = new URLSearchParams({
    client_id: clientId(),
    response_type: "code",
    redirect_uri: redirectUri(),
    scope: SCOPES.join(" "),
    state,
    response_mode: "query",
    prompt: "select_account",
  });
  return `${authBase()}/authorize?${params.toString()}`;
}

// Microsoft Graph: GET /me to fetch the signed-in user's profile.
const GRAPH_ME_URL = "https://graph.microsoft.com/v1.0/me";

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
    const tokenRes = await fetch(`${authBase()}/token`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id: clientId(),
        client_secret: clientSecret(),
        code,
        redirect_uri: redirectUri(),
        grant_type: "authorization_code",
        scope: SCOPES.join(" "),
      }).toString(),
    });
    if (!tokenRes.ok) {
      const txt = await tokenRes.text();
      throw new Error(`Microsoft token exchange failed (${tokenRes.status}): ${txt}`);
    }
    const tokens = (await tokenRes.json()) as {
      access_token: string;
      refresh_token?: string;
      expires_in?: number;
      scope?: string;
      token_type?: string;
    };

    // 2. Fetch profile from Graph
    const profileRes = await fetch(GRAPH_ME_URL, {
      headers: { Authorization: `Bearer ${tokens.access_token}` },
    });
    if (!profileRes.ok) {
      const txt = await profileRes.text();
      throw new Error(`Microsoft Graph /me failed (${profileRes.status}): ${txt}`);
    }
    const profile = (await profileRes.json()) as {
      mail?: string;
      userPrincipalName?: string;
      displayName?: string;
    };
    const email = (profile.mail || profile.userPrincipalName || "").toLowerCase();
    if (!email) throw new Error("Microsoft profile returned no email");

    const tokenExpiry =
      typeof tokens.expires_in === "number"
        ? Date.now() + tokens.expires_in * 1000
        : undefined;

    const accountId: Id<"mailAccounts"> = await ctx.runMutation(
      internal.mailAccounts._upsertOAuthAccount,
      {
        userId,
        provider: "MICROSOFT",
        email,
        displayName: profile.displayName,
        encryptedAccessToken: await encrypt(tokens.access_token),
        encryptedRefreshToken: tokens.refresh_token
          ? await encrypt(tokens.refresh_token)
          : undefined,
        tokenExpiry,
        scopes: SCOPES,
      },
    );

    return { accountId, email, platform };
  },
});

export const refreshToken = internalAction({
  args: {
    accountId: v.id("mailAccounts"),
    refreshToken: v.string(),
  },
  handler: async (ctx, { accountId, refreshToken }): Promise<string> => {
    const res = await fetch(`${authBase()}/token`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id: clientId(),
        client_secret: clientSecret(),
        refresh_token: refreshToken,
        grant_type: "refresh_token",
        scope: SCOPES.join(" "),
      }).toString(),
    });
    if (!res.ok) {
      const txt = await res.text();
      throw new Error(`Microsoft token refresh failed (${res.status}): ${txt}`);
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
