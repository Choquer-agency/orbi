# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

Orbi Mail is a desktop-first internal agency email client built as an npm workspaces monorepo with four packages: `backend`, `frontend`, `electron`, and `shared`.

## Commands

### Development
```bash
npm run dev:web          # Start backend (port 3001) + frontend (port 5173) concurrently
npm run dev:electron     # Start backend + Electron shell (primary dev mode)
```

### Prerequisites (macOS Homebrew)
```bash
brew services start postgresql@16
brew services start redis
```

### Database
```bash
npm run db:generate      # Regenerate Prisma client after schema changes
npm run db:migrate       # Create and apply a new migration
npm run db:seed          # Seed with test data (admin@orbi.agency / orbi2024)
npm run db:studio        # Open Prisma Studio GUI
```

### Build & Lint
```bash
npm run build            # Build shared → backend → frontend (order matters)
npm run lint             # ESLint across all packages
```

## Architecture

### Backend (`packages/backend/`) — Fastify 5 on port 3001

- **Entry**: `src/index.ts` builds the app, starts the server, then starts BullMQ workers.
- **App assembly**: `src/app.ts` registers plugins (Prisma, Redis) and all route modules.
- **Plugins** (`src/plugins/`): Fastify plugins that decorate the instance — `app.prisma` (PrismaClient) and `app.redis` (IORedis). Access these via the Fastify instance in route handlers.
- **Auth**: JWT-based. `src/middleware/authenticate.ts` is a `preHandler` hook — routes call `{ preHandler: [authenticate] }`. JWT payload contains `{ userId, email, role }`, accessed via `request.user`.
- **Env config**: `src/config/env.ts` loads `.env` from the repo root (not from `packages/backend/`) using Zod validation. All env vars accessed via the `env` export.
- **Route pattern**: Each route file is a Fastify plugin registered with a prefix (e.g., `/api/threads`). Routes use `app.prisma` for DB access.
- **BullMQ workers** (`src/workers/`): Background jobs for email sync, send, classify, follow-up, scheduled send. Queue connection config is in `src/queues/connection.ts` — uses parsed URL components (not a shared IORedis instance) to avoid version conflicts with BullMQ's bundled ioredis.
- **AI services** (`src/services/ai/`): Claude-powered assistants for chat, drafting, classification, meeting detection, follow-ups. `thread-context.ts` and `style-context.ts` are shared context builders used across AI features. AI chat uses SSE streaming via `POST /api/ai/chat/stream`.

### Frontend (`packages/frontend/`) — React 19 + Vite on port 5173

- **State management**: Zustand stores in `src/stores/` — `authStore` (persisted to localStorage), `uiStore`, `aiChatStore`, `undoSendStore`.
- **API client**: `src/lib/api.ts` — singleton `ApiClient` class with typed methods (`get`, `post`, `patch`, `put`, `delete`). Auto-injects JWT from auth store. Auto-logout on 401.
- **Data fetching**: TanStack React Query hooks in `src/hooks/` — one hook file per domain (e.g., `useThreads.ts`, `useContacts.ts`). These wrap the API client with caching and invalidation.
- **Vite proxy**: Dev server proxies `/api` and `/socket.io` to the backend at port 3001, so the frontend uses relative paths (no hardcoded backend URL).
- **Path alias**: `@/` maps to `packages/frontend/src/`.
- **Styling**: Tailwind CSS 4 via `@tailwindcss/vite` plugin. UI primitives from Radix UI. Rich text editing with TipTap.

### Shared (`packages/shared/`) — TypeScript types shared between packages

### Electron (`packages/electron/`) — Electron 35 shell via Electron Forge

### Database — PostgreSQL 16 + Prisma 6

- Schema at `prisma/schema.prisma` (repo root, not inside a package).
- Local dev: user `orbi`, database `orbi_mail`, password `orbi_dev`.
- 25+ models covering email, threads, AI classification, tracking, handoffs, scheduled send, contacts, snippets, and more.

## Key Patterns

- **Route auth**: All protected routes use `{ preHandler: [authenticate] }` and access the user via `request.user.userId`.
- **AI model**: Uses `claude-sonnet-4-6` via `@anthropic-ai/sdk`. AI services use tool_use for structured outputs (generate_draft, summarize_thread, etc.).
- **Real-time**: Socket.io for live notifications and updates, proxied through Vite in dev.
- **Background jobs**: BullMQ queues with Redis. Workers are started/stopped with the server lifecycle in `src/index.ts`.
