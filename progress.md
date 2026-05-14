# Progress

## Status
Recon complete — cost-reduction + follow-up wiring reviewed end-to-end.

## Tasks
- [x] (a) Confirm `ai.usageData._record` / `_dailyUsage` wiring from chat.ts, http.ts, classifier.ts, draft.ts, followUp.ts, taskExtractor.ts.
- [x] (a) Verify `aiUsageLogs` indexes vs. `_dailyUsage` query.
- [x] (b) Confirm `_ensureWatchForEmail` is `internalMutation` and callers use `ctx.runMutation`.
- [x] (c) Confirm new `by_status_nextCheckAt` index is used in `_listDueWatches`.
- [x] (d) Inspect `deterministicNoiseCategory` path for AI usage logging.
- [x] (e) Verify front-end useAiChat.ts no longer falls back after streaming starts.
- [x] (f) Verify `classifyEmailWithContext` is inbound-only; outbound promise tracking path.
- [x] (g) Confirm no Sonnet @ `max_tokens: 4096` remain.
- [x] (h) Verify `Doc<"emails">` typing in `compactThreadEmails`.

## Files Reviewed
- convex/ai/usageData.ts
- convex/ai/chat.ts
- convex/ai/http.ts
- convex/ai/classifier.ts
- convex/ai/classifierData.ts
- convex/ai/draft.ts
- convex/ai/followUp.ts
- convex/ai/taskExtractor.ts
- convex/ai/learn.ts (sanity for Sonnet usage)
- convex/ai/meetingDetector.ts (sanity for Sonnet usage)
- convex/emails.ts (actuallySend outbound branch)
- convex/followUps.ts
- convex/classifications.ts
- convex/sync/gmailData.ts (_onNewEmailInserted)
- convex/sync/microsoftData.ts (_onNewEmailInserted)
- convex/lib/threadContext.ts
- convex/schema.ts (aiUsageLogs, followUpWatches indexes)
- packages/frontend/src/hooks/useAiChat.ts
- packages/frontend/src/stores/aiChatStore.ts (finalizeStreamingMessage signature)

## Findings Summary

### Wired correctly
- `_record` / `_dailyUsage` referenced from all six callers via `(internal as any).ai.usageData.*`.
- `aiUsageLogs.by_user_createdAt` matches `_dailyUsage` query at `convex/ai/usageData.ts:44`.
- `followUps._ensureWatchForEmail` declared `internalMutation` at `convex/followUps.ts:53`; called from `convex/ai/classifier.ts:312` and `convex/emails.ts:646`.
- `followUpWatches.by_status_nextCheckAt` added (`convex/schema.ts:504`) and used at `convex/followUps.ts:217` with `take(25)`.
- Streaming front-end (`packages/frontend/src/hooks/useAiChat.ts:224`) now short-circuits the non-streaming fallback once `streamingMsgId` is set; only nulled after successful persist.
- `classifyEmailWithContext` gated on `!isOutbound` in both `gmailData.ts:434` and `microsoftData.ts:436`. Outbound promise tracking handled in `emails.actuallySend` (`convex/emails.ts:644-651`).
- No remaining Sonnet `max_tokens: 4096`; CHAT/DRAFT capped at 1536, follow-up 350, task extract 1024, task resolve 512, classifier 200.
- `compactThreadEmails(emails: Doc<"emails">[]): Doc<"emails">[]` typing matches `ctx.db.query("emails")` collect return shape (`convex/lib/threadContext.ts:126`). `Doc` already imported at line 10.

### Concerns / regressions to flag
- Outbound emails no longer get `emailClassifications` rows (classifier skipped for outbound). Any UI/query relying on classification of sent mail will silently regress.
- Outbound promise watches only fire when sent via `actuallySend`. Mail composed in Gmail/Outlook UI and synced inbound on the sent-folder side will not auto-create a watch. Confirm if intentional.
- `deterministicNoiseCategory` skips `recordAiUsage`. Fine for cost telemetry, but you lose call-count for deterministic-vs-LLM split. Optional improvement: log with `providerCallCount: 0`.
- `(internal as any)` casts at 8 sites can drop once `convex codegen` regenerates `_generated/api` to restore static typing.
- `aiUsageLogs.by_feature_createdAt` index defined but not yet consumed by any query.
- `convex/ai/learn.ts` still uses Sonnet for a 256-token call — candidate for Haiku.
- `compactToolJson` produces non-JSON when truncated (string concatenation suffix). Claude tolerates this; just don't `JSON.parse` it downstream.

## Notes
No code changes made — recon-only request. All findings include file:line refs above.
