import { useEffect } from 'react';
import { Fingerprint } from 'lucide-react';

interface BiometricLockOverlayProps {
  isAuthenticating: boolean;
  onUnlock: () => void;
}

export function BiometricLockOverlay({ isAuthenticating, onUnlock }: BiometricLockOverlayProps) {
  // Auto-trigger authentication on mount
  useEffect(() => {
    const timer = setTimeout(onUnlock, 300);
    return () => clearTimeout(timer);
  }, [onUnlock]);

  return (
    <div className="fixed inset-0 z-[9999] flex flex-col items-center justify-center bg-surface-warm">
      <div className="flex flex-col items-center gap-6">
        {/* App icon placeholder */}
        <div className="flex h-20 w-20 items-center justify-center rounded-[18px] bg-primary/10">
          <span className="text-3xl font-bold text-primary">O</span>
        </div>

        <h1 className="text-lg font-semibold text-text-primary">Orbi Mail</h1>

        <button
          onClick={onUnlock}
          disabled={isAuthenticating}
          className="flex items-center gap-2 rounded-full bg-primary/10 px-6 py-3 text-sm font-medium text-primary transition-colors active:bg-primary/20 disabled:opacity-50"
          aria-label="Tap to unlock with biometrics"
        >
          <Fingerprint className="h-5 w-5" />
          {isAuthenticating ? 'Authenticating...' : 'Tap to Unlock'}
        </button>
      </div>
    </div>
  );
}
