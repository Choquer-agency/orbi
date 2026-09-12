# Clients and email-to-ticket workflow

Implementation spans Orbi and the Choquer ERP (`Choquer-agency/app`, local checkout
`../Choquer Agency - Client Portal/insightpulse`). Both applications must be deployed
together before the new workflow is available to the team. No macOS packaging is
needed for the web UI; follow `electron-auto-updates.md` if distributing a native release.

## Behaviour

- Today / Clients appears in the user's own inbox. Clients lists unresolved client
  conversations, oldest unanswered message first, including read and archived mail.
  The list reuses Today's email rows. No reply needed appears beside the latest
  unanswered client message's date in the conversation.
  A fixed baseline of June 11, 2026 at midnight Vancouver time excludes older
  messages without deleting them. This is not a rolling window: eligible requests
  remain until addressed, and new messages on older threads enter normally.
- Matching uses the ERP's active clients, corporate domains, primary contacts, and
  exact sender links saved in the ERP. Public mail domains never match wholesale.
  Ambiguous matches require an explicit sender link.
- First use initializes the directory; a 15-minute cron keeps registered
  workspaces current. Directory errors preserve the last successful snapshot and
  display an error. A complete paginated history scan runs after directory changes.
  Toggling away keeps the list subscription and loaded pages mounted. Returning
  does not call the ERP; the refresh button remains available. The status query
  reads only directory state, never the high-churn pending scan queue.
- Gmail/Microsoft ingest, thread spam/trash changes, and successful Orbi sends update
  an indexed reply queue. Drafts, failed/queued sends, forwards, and internal-only
  discussion do not clear a client request. No reply needed clears through the
  reviewed incoming message; new mail returns. Ticket creation does not clear mail.
  Dismissal optimistically removes the matching message from cached list pages,
  with automatic rollback on failure. It does not rescan settled threads. Successful
  sends clear a known addressed request in the send transaction before background
  reconciliation. The next two client conversations are prefetched.
- Create tickets appears beside Reply all in an owned conversation. It uses the
  newest incoming email plus up to 19 earlier messages, with an explicit notice if
  older context exists. The source email is fixed throughout review and creation.
- The ERP's existing extractor runs in `client_email` mode with a request-splitting
  override. Suggested completion times: new page/blog 5 business days; two pages
  as one deliverable 8; small edits 2; substantial updates 3. Explicit deadlines
  take precedence. Assignees and dates remain editable; estimates do not represent
  a capacity calculation.
- Each proposal can be selected, edited, or skipped. Missing requests can be added
  manually. All attachments are included by default and can be deselected per
  ticket. Supported images are analyzed; unread formats/oversized images produce
  review warnings. Attachment transfer failures prevent ticket creation.
- ERP copies approved attachments to its own Convex storage. Its authenticated
  attachment endpoint resolves storage URLs on demand. Limits are 30 tickets,
  30 source attachments, 20 MB per transferred file, 10 analyzed images (4 MB each,
  12 MB total), and 150,000 characters of email context. Exceeding a hard limit
  reports an error instead of silently dropping content.
- An atomic ERP mutation creates tickets, assignees, attachment records, audit
  entries, and a source receipt together. A receipt keyed by the original internet
  message ID prevents duplicate batches across retries and mailbox copies. When
  unavailable, the fallback is account email plus provider message ID. Existing
  receipts are shown when reopening the same source email.
- Confirmed ticket titles and dates populate an editable prompt in the right-hand
  Orbi chat. The teammate adds notes and starts generation. Existing Create draft
  and send controls remain the final steps; no client email sends automatically.

## Configuration and rollout

1. ERP Convex needs `ORBI_INTAKE_KEY`, the **same** existing shared secret used by
   ERP Vercel's `ORBI_INTAKE_KEY` and Orbi Convex's `CHOQUER_INTAKE_KEY`.
2. ERP Vercel needs its existing `NEXT_PUBLIC_CONVEX_URL`, `ORBI_INTAKE_KEY`, and AI
   configuration. Both ERP Vercel and ERP Convex need `ORBI_SITE_URL` pointing to
   Orbi's production `.convex.site` URL. This restricts attachment downloads to
   Orbi's storage origin. Never expose these shared keys in browser environment variables.
3. Deploy ERP Convex first (new `orbi*` tables, internal operations, and protected
   `/orbi/workflow` HTTP route), then ERP Next.js (protected external workflow and
   authenticated ticket-file routes).
4. Deploy Orbi Convex using `docs/convex-deployment.md`, then the Orbi frontend.
   `CHOQUER_APP_URL` optionally overrides `https://choquer.app` for integration
   testing; production uses the default.
5. Sign in with an Orbi account whose email matches an active ERP teammate and
   whose workspace has `team_hub`. Open Clients and wait for history indexing.
6. Check one client conversation, a manual sender link, and a ticket review.
   Creating test tickets or sending mail is a separate deliberate user action;
   automated verification uses fixtures and never creates live client tickets.

Orbi source links use `https://orbi-mail.vercel.app/?threadId=...` and resolve after
sign-in. ERP ticket links use its existing `/admin/tickets?ticket=...` route.

## Verification

Orbi: `npm run typecheck`, `npm run build`, `npx vitest run`.
ERP: `npx tsc --noEmit`, `npm run build`, and
`npx vitest run convex/orbi.test.ts app/api/external/orbi/workflow/route.test.ts app/api/admin/meeting-notes/route.test.ts`.

The tests cover reply lifecycle, aliases, long-thread pagination, old/archived mail,
manual sender matching, authorization, atomic rollback, duplicate retries,
attachment ownership, independent extraction, review edits and the chat handoff.
