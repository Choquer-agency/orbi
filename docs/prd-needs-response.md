# PRD — Needs Response

**Status:** v1 shipped (this session), needs hardening before being trustworthy. The user's stated bar: *"we want it to be something that we can truly, truly rely on."* Every false positive erodes trust 10× more than a true positive earns it back.

**Owner:** Bryce.

---

## 1. Problem

Real client emails get buried in a busy mailbox. The user opens their inbox 50× a day and re-scans the same 20 threads trying to remember "did I answer this one?" The cost of missing a single client ask is high (lost revenue, damaged relationship). The cost of having to *check* the inbox to feel confident is real ongoing friction.

We want a view the user can trust as the only place they need to look to know "what owes a reply right now." If something matters, it's in there. If it's in there, it actually matters.

## 2. User Story

> As an agency owner with 5 mail accounts and ~100 inbound emails/day, I want a single curated list of threads that need my reply, ranked so the most-urgent five are at the top. I want to click into any of them, reply or mark Done, and move on. I never want to see a thread there that I already handled, that I was only CC'd on, that's a "thanks for the help" closer, or that's an automated digest. If a real client question is buried 6 weeks deep in a chain, I want it in this list — recency doesn't matter, importance does.

## 3. Current State (v1 in main branch)

### What's shipped
| Piece | Location | Notes |
|---|---|---|
| Schema | `convex/schema.ts` `needsResponseSignals` | One row per scored email |
| AI scorer | `convex/ai/needsResponse.ts` `scoreEmail` | Claude Haiku 4.5; ~$0.0001/email |
| Scorer data loader | `convex/ai/needsResponseData.ts` `_loadForScoring` | Returns email + category + thread context + isUserOutbound + userAlreadyRepliedInThread |
| Sync dispatch | `convex/sync/gmailData.ts` / `microsoftData.ts` in `_onNewEmailInserted` | Scores inbound; dismisses signals on outbound |
| Folder query | `convex/needsResponse.ts` `list` | Top 5 by score, divider, next 5 by email receivedAt |
| Auto-dismiss | `_dismissOpenSignalsForThread` invoked from `emails.send/reply/forward`, `drafts.sendDraft`, `threads.update`, `threads.markArchived` | Idempotent |
| Manual dismiss | `convex/needsResponse.ts` `dismissThread` mutation; toolbar button | Wired into `EmailViewer` Done button |
| Daily re-score cron | `convex/crons.ts` "needs-response-rescore" | Rescores items >24h old |
| Folder UI | `packages/frontend/src/components/thread-list/NeedsResponseList.tsx` | Replaces snippet with AI reason in this view |
| Done button | `packages/frontend/src/components/email-viewer/EmailViewer.tsx` | Green ✓, visible only when signal is open |
| Backfill admin | `convex/admin/backfillNeedsResponse.ts` | Self-chaining; ran for ~9k emails |
| 3-month refresh admin | `convex/admin/refresh3Months.ts` | Phase 1: dismiss >90d open signals. Phase 2: rescore last 90d |
| Bulk rescore admin | `convex/admin/rescoreAllOpen.ts` | Sweep open signals through latest scorer |

### Scoring heuristics layered in v1
1. **Hard skip — outbound:** `fromAddress` matches any connected account or alias → don't score.
2. **Hard skip — category:** classifications in `{marketing, spam, notification}` → don't score.
3. **Hard skip — body too short** (< 30 chars).
4. **Hard skip — acknowledgment pattern:** regex match against `^(thanks|got it|perfect|sounds good|...)` etc. with signature/quoted-block trimming.
5. **AI call** with thread context: last 3 messages tagged `USER` / `THEM`, plus an explicit "user already replied" state line. Prompt forbids spam, biases toward at-least-70 for client questions, caps at 15 for closure messages.
6. **Post-AI guard:** if user already replied and AI score < 50, drop the signal entirely.

### Dismissal triggers
- User sends any email into the thread (reply/forward/send/sendDraft)
- User archives or trashes the thread
- User clicks Done in EmailViewer
- Outbound email from another connected account in the same thread (via sync's `_onNewEmailInserted`)

## 4. Known Issues Observed in v1

These are the failure modes we hit. The next iteration should treat them as regression tests.

### Trust-eroding false positives
- **Stale alias-not-yet-configured signals.** Historical backfill scored emails before `andres@choquer.agency` had its `seo@choquercreative.com` alias set, so internal emails got flagged as inbound from external sender. Fixed reactively by a one-shot dismiss; should be impossible going forward but the underlying class of bug (state-at-score-time vs state-at-display-time) is generic.
- **"Thanks Bryce." closer flagged on a resolved billing thread.** Solved with pre-filter + thread context + prompt closure rule. Watch for variants the regex misses.
- **CC vs To not distinguished.** "Urgent — Lead Quality" sent by Andres TO Jonah with Bryce CC'd — flagged because subject + "let us know" body looked like an ask. The actual ask is directed at Jonah. **The prompt has no signal for to-vs-cc; the loader doesn't pass it.**
- **Internal team emails.** Same root cause as above — agency teammates emailing on behalf of the team aren't always self per the alias check (e.g. shared client threads). Need explicit "this sender is your teammate" signal.

### UX bugs
- **"Recent" section showed December emails** because it was sorted by `computedAt` (when the AI looked at it). Fixed mid-session — now sorted by email `receivedAt`. Verify on next pass.
- **Phase-1 dismissal may not cover all signals** — the loop uses `take(500)` chunks with creation-time cursors; should be reliable but wasn't verified end-to-end.
- **No "wrong answer" feedback.** Clicking Done is ambiguous — could mean "I handled it" or "this shouldn't be here." We learn nothing from it.

### Cost / performance
- **`threads.get` blew the 16MB read limit** on long threads with image-embedded bodies. Hardened by capping to latest 10 emails + per-email body cap, but real fix is moving large bodies to Convex storage. Not in v1 scope.
- **Open-signal scan in `needsResponse.list` uses `take(500)`** with no pagination. Fine today; ceiling problem for an inbox with thousands of unresponded threads.
- **Every inbound email triggers an AI call.** Acceptable at current volume (~$0.04/mo) but scales linearly with mailbox size.

## 5. Goals for v2

In priority order — top items are the trust-makers:

### P0 — reliability (must fix before users trust this)
1. **CC-vs-To awareness.** Loader passes `userIsDirectAddressee` (To includes a user-owned address) vs `userIsCcd` (CC/BCC includes a user-owned address). Prompt: CC-only emails score lower by default; explicit asks-to-someone-else even when you're CC'd should never score >40.
2. **Team-internal sender detection.** Treat any sender from a domain that maps to a connected account (or that has been auto-detected via the alias inference scanner) as internal. Internal senders bias toward lower scores unless the body has a direct ask to the user by name.
3. **Per-user calibration loop.** Add a "Not for me" or "Why is this here?" affordance on the card (distinct from Done). Stores feedback. Re-score future similar emails by including that feedback in the prompt (similar to how `triageFeedback` feeds into the classifier today).
4. **Re-evaluate on configuration change.** When aliases are added/removed, queue a rescore of all open signals whose `fromAddress` matches any new alias. Don't make the user wait for the next AI pass.
5. **Time-window enforcement at score time, not just display.** If `receivedAt` is > 90 days old (or whatever the user's configured retention is), `scoreEmail` returns early. Today's only safety is admin scripts dismissing stale signals.

### P1 — UX polish
6. **Deadline surfacing.** Use the AI-extracted `dueByHint` to bias top-5 ranking (`score + (deadline_urgency * weight)`) and show a "Due in 2 days" pill on the card.
7. **Explainability.** Hover or expand-on-click shows the AI's reasoning (not just the one-line reason). Maybe show: "Flagged because: direct ask + you haven't replied + deadline mentioned."
8. **Per-account scoping.** Lets the user view Needs Response for one mailbox only (default is all merged).
9. **Empty-state delight.** "Inbox zero on responses" is fine; can be friendlier.
10. **"Load older messages" affordance in long threads** — relates to the byte-limit clip in `threads.get`.

### P2 — performance / cost
11. **Score on demand for older mail.** Below some receivedAt threshold (e.g. >7 days, no signal yet), skip background scoring entirely. If the user opens that thread, score it lazily.
12. **Confidence threshold setting.** Today everything ≥1 persists. A per-user "only show me high-confidence" slider, default 70, drops the chatter.
13. **Open-signal count pagination.** When ≥1,000 open signals, query needs to walk in chunks and not collect-all.

## 6. Detailed Behavior — what v2 should do

### Scoring contract

The scorer is given:
- The latest email's `subject`, `fromAddress`, `fromName`, `bodyText` (1500 char cap)
- The last 3 messages in the thread, in order, each tagged USER / THEM
- A boolean: has the user already replied in this thread?
- **New for v2:** `userIsDirectAddressee` boolean (user owns an address in To)
- **New for v2:** `userIsCcd` boolean (user owns an address in CC/BCC only)
- **New for v2:** `senderIsTeamInternal` boolean (sender is on a user-owned domain or in the team-detection set)
- **New for v2:** recent user feedback corrections (top 5–10 most relevant "not for me" / "this was important" examples for sender or category)

Returns: `{ score: 0–100, reason: string ≤80 chars, dueBy: YYYY-MM-DD | null }`

### Persistence rules
- Skip persist entirely if:
  - Outbound, body too short, ack-pattern match (today)
  - **New:** `userIsCcd && !userIsDirectAddressee && score < 60`
  - **New:** `senderIsTeamInternal && score < 70`
  - **New:** Email older than user's retention window
- Otherwise insert/patch signal row, leaving any existing dismissedAt untouched (dismissed stays dismissed).

### Display contract — `needsResponse.list`

Returns two arrays:
- `topUrgent`: highest-score-first, max 5, deduped by thread.
  - **New for v2:** apply a deadline-urgency bonus to ranking (deadline within 48h → +30 effective score for ranking purposes only).
- `topRecent`: max 5, sorted by email's `receivedAt` desc (not `computedAt`), already deduped against `topUrgent`.

### Dismissal triggers (additive list)
- User sends into thread → all open signals on thread dismissed (v1)
- User archives or trashes thread → dismissed (v1)
- User clicks Done → dismissed (v1)
- **New:** User clicks "Not for me" → dismissed AND feedback row written (for future prompt context)
- **New:** Outbound from another connected account → dismissed (v1, via outbound sync; verify)
- **New:** A teammate's reply (when that's detectable) → dismissed only if `!userIsDirectAddressee`. If user was directly addressed, the teammate replying doesn't resolve it for the user.

## 7. Open Design Questions

- **Manual "star this sender" / "I always reply to this person fast"** — should we surface a way for the user to bias the scorer per sender, or is the implicit feedback loop sufficient?
- **Sender importance tiers** — should we mine the contacts table (frequency of past replies, days since last touch) to compute a sender-importance score that biases the AI? `useContactNameResolver` already aggregates emailCount.
- **Snooze vs Done** — "I'll handle this Wednesday" is a real flow. Today the only escape is reply/dismiss/archive. Should snooze re-flag automatically when the snooze fires?
- **Multiple Needs Response timeframes** — Today (urgent), This Week, Anytime? Or one flat list?
- **Bulk Done** — checkboxes + "Done All" for a clean-out moment?
- **Time-of-day awareness** — emails received during business hours from clients should weight higher than the 11pm marketing-but-personalized blast.

## 8. Architecture references (for the new thread)

- Schema: `convex/schema.ts` lines 651–668 (search `needsResponseSignals`)
- Scorer: `convex/ai/needsResponse.ts` (uses `"use node"` runtime for Anthropic SDK)
- Backing queries/mutations: `convex/ai/needsResponseData.ts` (V8 runtime, has DB access)
- Folder query + manual dismiss + daily cron: `convex/needsResponse.ts`
- Dispatch hooks: `convex/sync/gmailData.ts` + `convex/sync/microsoftData.ts` `_onNewEmailInserted`
- Auto-dismiss hooks: `convex/emails.ts` (`reply`, `forward`, `sendNow`), `convex/drafts.ts` (`sendDraft`), `convex/threads.ts` (`update`, `markArchived`)
- Cron registration: `convex/crons.ts` "needs-response-rescore"
- Frontend folder view: `packages/frontend/src/components/thread-list/NeedsResponseList.tsx`
- Frontend Done button: `packages/frontend/src/components/email-viewer/EmailViewer.tsx` (search `needsResponseOpen?.open`)
- Smart folder registration: `packages/frontend/src/lib/constants.ts` SMART_FOLDERS `{ id: 'needs_response' }`
- Folder routing branch: `packages/frontend/src/components/thread-list/ThreadList.tsx` (search `selectedFolder === 'needs_response'`)

## 9. Acceptance criteria for v2

A user uses the app for a week and:
- Every email in Needs Response is one the user agrees they should reply to (or "I was going to reply to that").
- No email the user feels they should reply to is missing from the list.
- The list reorders correctly when the user replies or marks Done — no ghost entries.
- The top-5 vs next-5 distinction feels meaningful (top 5 are the "if I do nothing else today, these" emails).
- The user opens the folder more often than they open Primary as a "first stop in the morning."

If those hit, this feature has earned the trust the user asked for.

## 10. Out of scope (parking lot)

- Multi-user shared "team needs response"
- Slack / mobile push notifications when high-urgency new entries appear
- "Snooze until Monday morning" with auto-re-flag
- Reply-draft generation directly from a card (already partially supported elsewhere via AI chat)
- Calendar integration — proposing reply windows based on the user's schedule

---

## Appendix — concrete improvements from this session

These should land early in v2 — they're cheap wins from feedback already gathered:

1. Add `userIsDirectAddressee` and `userIsCcd` to `_loadForScoring` return and the prompt input.
2. Add `senderIsTeamInternal` based on the connected-domain set.
3. Move the time-window check (90-day default, user-configurable) into `scoreEmail` itself so it's enforced uniformly.
4. Add a "Not for me" button next to Done that captures feedback into a new table (or extends `triageFeedback`).
5. Replace the `take(500)` open-signal scan in `list` with proper pagination once the open-signal count regularly exceeds ~200.
6. Move heavy email bodies out of the `emails` table into Convex storage when `bodyHtml.length > 500KB` so `threads.get` doesn't have to clip.
