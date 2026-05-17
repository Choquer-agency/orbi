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

// HTML response shown in the user's external browser after a desktop/native
// OAuth flow completes. We attempt the orbi-mail:// deep link to jump back
// into the app, and self-close the tab so the user isn't stranded on
// careful-warbler-543.convex.site if the protocol handler isn't installed.
function desktopOAuthCompletionPage(
  provider: "gmail" | "microsoft",
  ok: boolean,
  error?: string,
): Response {
  const deepLink = ok
    ? `orbi-mail://oauth/callback?provider=${provider}&success=true`
    : `orbi-mail://oauth/callback?provider=${provider}&success=false&error=${encodeURIComponent(error ?? "exchange_failed")}`;
  const headline = ok
    ? `${provider === "gmail" ? "Gmail" : "Microsoft"} account connected`
    : "Couldn't connect account";
  const body = ok
    ? "You can close this tab and return to Orbi Mail. The new account will appear in Settings → Accounts."
    : `Something went wrong: ${error ?? "unknown error"}. Close this tab and try again from Orbi Mail.`;
  const html = `<!doctype html><html><head><meta charset="utf-8"><title>${headline}</title><style>body{font:14px/1.55 -apple-system,BlinkMacSystemFont,Segoe UI,Helvetica,Arial,sans-serif;background:#fafaf7;color:#0f0f0f;margin:0;padding:48px 24px;display:flex;justify-content:center}main{max-width:440px;text-align:center}.dot{width:48px;height:48px;border-radius:9999px;margin:0 auto 16px;background:${ok ? "#0f8a4a" : "#d23a3a"};display:flex;align-items:center;justify-content:center;color:white;font-size:24px;font-weight:700}h1{font-size:18px;margin:0 0 8px}p{color:#555;margin:0 0 16px}button{font:inherit;background:#0f0f0f;color:white;border:0;padding:8px 16px;border-radius:8px;cursor:pointer}</style></head><body><main><div class="dot">${ok ? "✓" : "!"}</div><h1>${headline}</h1><p>${body}</p><button onclick="window.close()">Close this tab</button><script>try{location.replace(${JSON.stringify(deepLink)});}catch(e){}setTimeout(()=>{try{window.close()}catch(e){}},1500);</script></main></body></html>`;
  return new Response(html, {
    status: ok ? 200 : 400,
    headers: { "Content-Type": "text/html; charset=utf-8" },
  });
}

function isDesktopPlatform(p: string): boolean {
  return p === "desktop" || p === "capacitor";
}

export const gmailCallback = httpAction(async (ctx, req) => {
  const url = new URL(req.url);
  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");

  // Best-effort platform recovery so error redirects still hit the right shell.
  const platformGuess = state?.split("|")[1] || "web";

  if (!code || !state) {
    if (isDesktopPlatform(platformGuess)) {
      return desktopOAuthCompletionPage("gmail", false, "missing_code_or_state");
    }
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
    if (isDesktopPlatform(platform)) {
      return desktopOAuthCompletionPage("gmail", true);
    }
    return Response.redirect(redirectFor(platform, "gmail"), 302);
  } catch (err) {
    const msg = err instanceof Error ? err.message : "exchange_failed";
    if (isDesktopPlatform(platformGuess)) {
      return desktopOAuthCompletionPage("gmail", false, msg);
    }
    return Response.redirect(errorRedirectFor(platformGuess, "gmail", msg), 302);
  }
});

export const microsoftCallback = httpAction(async (ctx, req) => {
  const url = new URL(req.url);
  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");

  const platformGuess = state?.split("|")[1] || "web";

  if (!code || !state) {
    if (isDesktopPlatform(platformGuess)) {
      return desktopOAuthCompletionPage("microsoft", false, "missing_code_or_state");
    }
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
    if (isDesktopPlatform(platform)) {
      return desktopOAuthCompletionPage("microsoft", true);
    }
    return Response.redirect(redirectFor(platform, "microsoft"), 302);
  } catch (err) {
    const msg = err instanceof Error ? err.message : "exchange_failed";
    if (isDesktopPlatform(platformGuess)) {
      return desktopOAuthCompletionPage("microsoft", false, msg);
    }
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
