# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

Orbi Mail is a desktop-first internal agency email client built as an npm workspaces monorepo. Backend is fully on Convex (no separate server); frontend is React + Vite, packaged for Mac via Electron and for iOS via Capacitor.

## Packages
- `packages/frontend/` — React 19 + Vite + Tailwind UI (port 5173 in dev)
- `packages/electron/` — Electron 35 desktop shell (Mac DMG via Forge)
- `packages/ios/` — Capacitor iOS shell
- `packages/shared/` — TypeScript types shared across packages
- `convex/` — Convex backend (queries, mutations, actions, crons, HTTP endpoints, schema)

## Commands

### Development
```bash
npm run dev              # Convex dev watcher + frontend (port 5173)
npm run dev:electron     # Convex dev + Electron shell
npm run dev:ios          # Convex dev + frontend with --host (for device testing)
```

### Convex
```bash
npx convex dev           # Watch + push changes to dev deployment
npx convex deploy        # Push to production deployment
npx convex env list      # List env vars on the current deployment
npx convex env set X y   # Set an env var on the current deployment
npx convex dashboard     # Open the Convex dashboard
```

### Build & Package
```bash
npm run build               # Build shared + frontend
npm run package:mac:arm64   # Build Mac .dmg (Apple Silicon)
npm run build:ios           # Build the iOS frontend bundle for Capacitor sync
npm run sync:ios            # Build + sync into Xcode workspace
```

### Lint
```bash
npm run lint
```

## Architecture

### Convex backend (`convex/`)

- **Schema** at `convex/schema.ts`. Auth tables come from `@convex-dev/auth/server` (`...authTables`); `users` is extended with `role`, `displayName`, `avatarUrl`. Mailbox accounts (Gmail/Microsoft) live in `mailAccounts` (renamed from Prisma's `Account` to avoid colliding with Convex Auth's `accounts`).
- **Auth** uses Convex Auth with the `Password` provider. Login/sign-up via `useAuthActions().signIn("password", { ..., flow })`. Mailbox OAuth (connect Gmail/Microsoft for reading mail) is a separate flow in `convex/oauth/*` — not login OAuth.
- **Function organization**: one file per domain (e.g., `convex/threads.ts`, `convex/emails.ts`, `convex/signatures.ts`). AI functions live under `convex/ai/`. OAuth flows under `convex/oauth/`. Email sync workers under `convex/sync/`. APNs delivery under `convex/push/`. Tracking endpoints under `convex/tracking/`.
- **Node runtime**: any file using Anthropic SDK or other Node-only packages starts with `"use node";`. Convex disallows queries/mutations in node-runtime files — those go in a sibling `*Data.ts` (V8 runtime) file. Pattern: `convex/ai/chat.ts` (action, "use node") + `convex/ai/chatData.ts` (queries/mutations, V8).
- **Auth helper**: every protected query/mutation/action calls `await requireUser(ctx)` from `convex/lib/auth.ts`.
- **HTTP endpoints** (`convex/http.ts`): wires Convex Auth's routes plus AI chat streaming, OAuth callbacks (Gmail/Microsoft), tracking pixel, link-click redirect.
- **Crons** (`convex/crons.ts`): Gmail incremental sync (1 min), Microsoft incremental sync (1 min), scheduled-send dispatch (1 min), follow-up scan (1 hr).
- **Scheduler** (`ctx.scheduler.runAfter` / `runAt`): used for the 10s undo-send window, scheduled email sends, snooze unsnooze, follow-up draft generation, push delivery fan-out, sync chunk continuation.

### Frontend (`packages/frontend/`) — React 19 + Vite

- **State**: Zustand stores in `src/stores/` for UI-only state (`authStore`, `uiStore`, `aiChatStore`, `undoSendStore`).
- **Data**: `useQuery` / `useMutation` / `useAction` from `convex/react`, called via `import { api } from "../../../../convex/_generated/api"`. Queries are reactive — no manual cache invalidation. Hooks in `src/hooks/` keep `{ data, isLoading }` return shape for backward compat with components.
- **Auth**: wraps app in `<ConvexAuthProvider>` from `@convex-dev/auth/react` (in `main.tsx`). Use `useAuthActions()` for sign-in/out, `useConvexAuth()` for `{ isAuthenticated, isLoading }`, `useAuthToken()` for the bearer token (used for the AI chat streaming endpoint).
- **Streaming AI chat**: HTTP SSE to `${VITE_CONVEX_SITE_URL}/ai/chat/stream` with `Authorization: Bearer <token>`.
- **Path alias**: `@/` maps to `packages/frontend/src/`.
- **Env vars**: `VITE_CONVEX_URL` (queries WebSocket) and `VITE_CONVEX_SITE_URL` (HTTP actions). Values are in `.env.local` (gitignored) and `.env.electron` (for packaged builds).

### Electron (`packages/electron/`)

Thin shell pointing at the bundled frontend. CSP allows `convex.cloud` and `convex.site`. No local backend spawning.

## Key patterns

- **Fan-out for relations**: Convex has no `include`. Replace `prisma.x.findMany({ include: { y } })` with `Promise.all(ids.map(id => ctx.db.get(id)))`.
- **Compound indexes**: every multi-field query uses an index defined in `schema.ts`. Equality fields first, range last. Never use `.filter()` on hot paths.
- **AI model**: `claude-sonnet-4-6` for chat/draft/follow-up; `claude-haiku-4-5-20251001` for the email classifier. Tool_use schemas (`generate_draft`, `summarize_thread`, `extract_action_items`, `search_emails`, `lookup_contact`, `get_priority_inbox`, `get_tasks_and_deadlines`, `extract_tasks`, `resolve_tasks`) are preserved verbatim from the Fastify version.
- **Real-time**: Convex queries are reactive by default — no Socket.io. Mutations write data; subscribed `useQuery` re-renders automatically.
- **File uploads**: `generateUploadUrl` mutation → frontend POSTs file directly to Convex storage → metadata mutation stores the resulting `storageId: v.id("_storage")` on the attachment doc.
- **Action retries**: Convex actions are at-most-once. Email send / sync paths use status-doc + scheduler reschedule patterns instead of automatic retries.
