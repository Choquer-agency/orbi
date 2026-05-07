import type { HttpRouter } from "convex/server";
import { pixelHandler } from "./pixel";
import { linkHandler } from "./links";

// ─────────────────────────────────────────────────────────────────────────────
// Tracking HTTP routes — registered by the global httpRouter in convex/http.ts.
//
// Convex's HttpRouter only accepts an exact path or a prefix — there is no
// regex / param syntax. We use:
//   - `/p/`  pathPrefix → pixelHandler parses `<trackingId>.png` from the path
//   - `/t/`  pathPrefix → linkHandler parses `<trackingId>/<linkIndex>`
//
// Phase 4 (or whoever owns http.ts) only needs to call:
//
//     import { addTrackingHttpRoutes } from "./tracking/http";
//     addTrackingHttpRoutes(http);
// ─────────────────────────────────────────────────────────────────────────────

export function addTrackingHttpRoutes(http: HttpRouter) {
  http.route({
    pathPrefix: "/p/",
    method: "GET",
    handler: pixelHandler,
  });
  http.route({
    pathPrefix: "/t/",
    method: "GET",
    handler: linkHandler,
  });
}
