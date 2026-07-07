import toast from 'react-hot-toast';

// Strip Convex's verbose error framing down to the human part.
// "[CONVEX M(threads:update)] [Request ID: …] Server Error Uncaught Error:
//  Can only cancel emails with SCHEDULED status …" → the trailing message.
function cleanErrorMessage(raw: string): string {
  let msg = raw;
  const uncaught = msg.lastIndexOf('Uncaught Error:');
  if (uncaught >= 0) msg = msg.slice(uncaught + 'Uncaught Error:'.length);
  msg = msg.split('\n')[0].trim();
  if (msg.length > 140) msg = `${msg.slice(0, 140)}…`;
  return msg || 'Something went wrong';
}

/**
 * Default error surface for the compat `mutate()` wrappers in src/hooks/.
 *
 * Fire-and-forget callers (archive / star / delete / mark-read buttons)
 * historically dropped rejections when no onError was passed — the
 * optimistic update silently rolled back and the user believed the action
 * succeeded. Every wrapper now routes through here: callers that pass
 * onError keep full control; everyone else gets a visible toast.
 */
export function reportMutationError(
  err: unknown,
  onError?: (err: unknown) => void,
): void {
  if (onError) {
    onError(err);
    return;
  }
  console.error('Mutation failed:', err);
  const message =
    err instanceof Error ? cleanErrorMessage(err.message) : 'Something went wrong';
  // Stable id: a burst of failures (e.g. offline bulk-archive) collapses
  // into one toast instead of stacking.
  toast.error(message, { id: 'mutation-error' });
}
