import { AnimatePresence, motion } from 'framer-motion';
import { KeyRound } from 'lucide-react';
import { useQuery } from 'convex/react';
import { api as convexApi } from '../../../../../convex/_generated/api';
import { useUiStore } from '../../stores/uiStore';

// Shown when a mail account's refresh token has died (revoked / expired /
// password changed) — sync and send are silently broken for that account
// until the user reconnects it through OAuth. Before this banner, the only
// symptom was mail quietly going stale.
export function ReauthBanner() {
  const accounts = useQuery(convexApi.mailAccounts.list, {});
  const setSettingsOpen = useUiStore((s) => s.setSettingsOpen);
  const broken = (accounts ?? []).filter((a) => a.needsReauth);

  return (
    <AnimatePresence>
      {broken.length > 0 && (
        <motion.div
          initial={{ height: 0, opacity: 0 }}
          animate={{ height: 'auto', opacity: 1 }}
          exit={{ height: 0, opacity: 0 }}
          transition={{ duration: 0.2 }}
          className="overflow-hidden"
        >
          <button
            type="button"
            onClick={() => setSettingsOpen(true)}
            className="flex w-full items-center justify-center gap-2 bg-red-500/90 px-3 py-1.5 text-xs font-medium text-white hover:bg-red-600/90"
          >
            <KeyRound className="h-3.5 w-3.5" />
            <span>
              {broken.length === 1
                ? `${broken[0].email} lost its connection — click to reconnect in Settings`
                : `${broken.length} accounts lost their connection — click to reconnect in Settings`}
            </span>
          </button>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
