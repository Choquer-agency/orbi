import { AnimatePresence, motion } from 'framer-motion';
import { WifiOff } from 'lucide-react';
import { useNetworkStatus } from '../../hooks/useNetworkStatus';

export function OfflineBanner() {
  const { isOnline } = useNetworkStatus();

  return (
    <AnimatePresence>
      {!isOnline && (
        <motion.div
          initial={{ height: 0, opacity: 0 }}
          animate={{ height: 'auto', opacity: 1 }}
          exit={{ height: 0, opacity: 0 }}
          transition={{ duration: 0.2 }}
          className="overflow-hidden"
        >
          <div className="flex items-center justify-center gap-2 bg-amber-500/90 px-3 py-1.5 text-xs font-medium text-white">
            <WifiOff className="h-3.5 w-3.5" />
            <span>You're offline — showing cached emails</span>
          </div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
