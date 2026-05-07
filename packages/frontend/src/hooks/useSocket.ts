// ─────────────────────────────────────────────────────────────────────────────
// DEPRECATED — Socket.io is gone.
//
// Convex queries auto-subscribe and re-render on data changes, so the
// realtime invalidation loop (notification:new, threads:updated, etc.) is
// no longer needed. This stub exists only so existing callers
// (`AppLayout` calls `useSocket()` once at mount) keep type-checking until
// they are removed.
// ─────────────────────────────────────────────────────────────────────────────

export function useSocket(): void {
  // no-op
}
