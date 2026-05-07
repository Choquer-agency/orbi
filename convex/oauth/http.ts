// ─────────────────────────────────────────────────────────────────────────────
// OAuth HTTP routes — Gmail + Microsoft callbacks.
//
// `addOAuthHttpRoutes(http)` is called from convex/http.ts (owned by the auth
// agent). It registers:
//   GET /api/accounts/oauth/gmail/callback?code=…&state=…
//   GET /api/accounts/oauth/microsoft/callback?code=…&state=…
//
// Each callback hands the auth code to its provider's `exchangeCode` internal
// action, which exchanges, fetches the profile, and upserts the mailAccount
// row. We then 302-redirect back into the app (web frontend or desktop deep
// link) so the user lands on the connected-accounts UI.
//
// Public routes — Convex HTTP actions don't run requireUser; the userId is
// embedded in the OAuth `state` parameter, which was signed/issued by an
// authenticated `getOAuthUrl` action above.
// ─────────────────────────────────────────────────────────────────────────────

import { httpAction } from "../_generated/server";
import { internal } from "../_generated/api";
import type { HttpRouter } from "convex/server";

function frontendUrl(): string {
  return process.env.FRONTEND_URL || "http://localhost:5173";
}

function redirectFor(platform: string, provider: "gmail" | "microsoft"): string {
  if (platform === "desktop" || platform === "capacitor") {
    return `orbi-mail://oauth/callback?provider=${provider}&success=true`;
  }
  return `${frontendUrl()}/oauth/callback?provider=${provider}&success=true`;
}

function errorRedirectFor(
  platform: string,
  provider: "gmail" | "microsoft",
  error: string,
): string {
  const enc = encodeURIComponent(error);
  if (platform === "desktop" || platform === "capacitor") {
    return `orbi-mail://oauth/callback?provider=${provider}&success=false&error=${enc}`;
  }
  return `${frontendUrl()}/oauth/callback?provider=${provider}&success=false&error=${enc}`;
}

export const gmailCallback = httpAction(async (ctx, req) => {
  const url = new URL(req.url);
  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");

  // Best-effort platform recovery so error redirects still hit the right shell.
  const platformGuess = state?.split("|")[1] || "web";

  if (!code || !state) {
    return Response.redirect(
      errorRedirectFor(platformGuess, "gmail", "missing_code_or_state"),
      302,
    );
  }
  try {
    const { platform } = await ctx.runAction(internal.oauth.gmail.exchangeCode, {
      code,
      state,
    });
    return Response.redirect(redirectFor(platform, "gmail"), 302);
  } catch (err) {
    const msg = err instanceof Error ? err.message : "exchange_failed";
    return Response.redirect(errorRedirectFor(platformGuess, "gmail", msg), 302);
  }
});

export const microsoftCallback = httpAction(async (ctx, req) => {
  const url = new URL(req.url);
  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");

  const platformGuess = state?.split("|")[1] || "web";

  if (!code || !state) {
    return Response.redirect(
      errorRedirectFor(platformGuess, "microsoft", "missing_code_or_state"),
      302,
    );
  }
  try {
    const { platform } = await ctx.runAction(
      internal.oauth.microsoft.exchangeCode,
      { code, state },
    );
    return Response.redirect(redirectFor(platform, "microsoft"), 302);
  } catch (err) {
    const msg = err instanceof Error ? err.message : "exchange_failed";
    return Response.redirect(
      errorRedirectFor(platformGuess, "microsoft", msg),
      302,
    );
  }
});

export function addOAuthHttpRoutes(http: HttpRouter) {
  http.route({
    path: "/api/accounts/oauth/gmail/callback",
    method: "GET",
    handler: gmailCallback,
  });
  http.route({
    path: "/api/accounts/oauth/microsoft/callback",
    method: "GET",
    handler: microsoftCallback,
  });
}
