// ─────────────────────────────────────────────────────────────────────────────
// promiseDetector.ts — pure regex-based check for sender-side follow-up
// commitments in an outbound email body. Used by:
//   - convex/emails.ts (after our own actuallySend)
//   - convex/sync/{gmail,microsoft}Data.ts (for mail sent in the native client
//     and synced back as outbound)
//
// No LLM. Bounded false-positive risk; per-thread+contact dedupe in
// _ensureWatchForEmail caps the blast radius.
// ─────────────────────────────────────────────────────────────────────────────

const APOSTROPHE = "(?:'|\u2019)";
const WILL_OR_SHALL = `(?:${APOSTROPHE}ll| will| shall|${APOSTROPHE}m going to| am going to)`;

const PATTERNS: RegExp[] = [
  new RegExp(
    `\\b(i|we)${WILL_OR_SHALL}\\s+(?:get back to you|follow up|circle back|loop back|send (?:it|that|this|over|the|a|you)|share|update you|let you know|reach out|come back to you|reply|respond|confirm|check)\\b`,
  ),
  new RegExp(`\\b(i|we)\\s+(?:owe you|will have|can get you|am working on|are working on)\\b`),
  /\b(send|sending|ship|shipping|deliver|delivering)\b[^.\n]{0,40}\b(tomorrow|today|tonight|by|once|when|this week|next week|shortly|soon|end of (?:day|week))\b/,
  new RegExp(`\\byou${APOSTROPHE}?ll\\s+(?:have|get|receive|see|hear back)\\b`),
  /\b(expect|expecting)\b[^.\n]{0,40}\b(draft|update|proposal|quote|invoice|estimate|reply|response)\b/,
];

export function promisedFollowUpText(text: string | undefined | null): boolean {
  if (!text) return false;
  const stripped = text.replace(/<[^>]+>/g, " ");
  const noQuotes = stripped
    .split("\n")
    .filter((line) => !line.trim().startsWith(">"))
    .join("\n");
  const normalized = noQuotes.toLowerCase();
  return PATTERNS.some((re) => re.test(normalized));
}
