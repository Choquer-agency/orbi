# Orbi performance roadmap

Goal: make packaged Electron feel comparable to Gmail/Spark for daily mail flows while preserving accuracy.

## Measured/known issues

- Packaged frontend had one large startup chunk (~1.4 MB raw) and mounted AI chat on desktop immediately.
- Thread list keyboard shortcuts created a second reactive `threads:list` subscription.
- Thread/list/search/backend paths had repeated read-amplification risks around full email docs.
- Thread detail and email rendering can still be expensive for long/newsletter threads.
- Convex Insights CLI could not access `careful-warbler-543` from the current logged-in Convex account; use dashboard/authorized account for production insights.

## Immediate fixes applied

- Removed duplicate `threads:list` subscription from keyboard shortcuts; shortcuts now use visible thread rows from `ThreadList`.
- Removed deprecated no-op socket startup call and dropped `socket.io-client` from Vite optimized deps.
- Lazy-loaded `AiChatPanel`, `EmailViewer`, dashboard, contacts, settings, and mobile compose into separate chunks.
- Reduced the packaged startup chunk from ~1.37 MB raw / ~408 KB gzip to ~805 KB raw / ~250 KB gzip.
- Replaced cumulative `useThreads` pagination (`limit * pageCount`) with bounded page-by-page fetching.
- Added desktop `ThreadList` virtualization without adding another dependency.
- Replaced thread-detail scheduled-email lookup with a thread-specific Convex query.
- Added `scheduledEmails.by_thread_status_sendAt` index.
- Earlier backend pass bounded/capped multiple read-limit-prone Convex queries.

## Next P0 work

1. Add packaged-app performance marks:
   - Electron app start
   - BrowserWindow created
   - ready-to-show
   - renderer mounted
   - first thread list data
   - first thread detail data
2. Move contact-name resolution out of row components and memoize `ThreadItem`.
3. Split the rich compose editor further from `EmailViewer` so the 368 KB compose chunk is only fetched when composing/replying.
4. Add a local cached inbox snapshot for instant packaged startup.
5. Replace page-number fetching with Convex cursor pagination once the backend list model is split into lightweight digest rows.

## Durable backend architecture

1. Split heavy email bodies from email metadata (`emailBodies` or equivalent). Convex reads full documents, so list/search queries must not touch docs containing `bodyHtml/bodyText`.
2. Add thread-list digest rows for inbox/tag/sent/draft lists.
3. Add compact search docs/indexes for UI + AI search.
4. Paginate thread detail and load older history explicitly.
5. Maintain counters/rollups for drafts, comments, dashboard, and AI usage where exact live scans are costly.

## Release rule

Every performance release should include:

- frontend build
- Convex typecheck/deploy if backend changed
- packaged Electron arm64+x64 builds
- Cloudflare R2 DMG, ZIP, `manual.json`, and `RELEASES.json` upload
- quick packaged smoke test on the slow Mac
