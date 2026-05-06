import { useState, useEffect, useCallback, useRef } from 'react';
import { isNative } from '../lib/platform';
import {
  shouldRequireAuth,
  authenticate,
  isLockEnabled,
} from '../lib/biometricLock';

/**
 * Manages the biometric lock lifecycle:
 * - Checks if lock should be shown on app foreground
 * - Handles authentication attempts
 * - Tracks locked/unlocked state
 */
export function useBiometricLock() {
  const [isLocked, setIsLocked] = useState(false);
  const [isAuthenticating, setIsAuthenticating] = useState(false);
  const checkedInitialRef = useRef(false);

  // Check lock state on mount (app launch)
  useEffect(() => {
    if (!isNative() || checkedInitialRef.current) return;
    checkedInitialRef.current = true;

    isLockEnabled().then((enabled) => {
      if (enabled) {
        setIsLocked(true);
      }
    });
  }, []);

  // Listen for app foreground events to check if re-auth is needed
  useEffect(() => {
    if (!isNative()) return;

    const handleForeground = async () => {
      try {
        const needsAuth = await shouldRequireAuth();
        if (needsAuth) {
          setIsLocked(true);
        }
      } catch {
        // If check fails, err on the side of security
      }
    };

    window.addEventListener('app-foreground', handleForeground);
    return () => window.removeEventListener('app-foreground', handleForeground);
  }, []);

  const unlock = useCallback(async () => {
    if (isAuthenticating) return;
    setIsAuthenticating(true);

    try {
      const result = await authenticate();
      if (result.success) {
        setIsLocked(false);
      }
      // If cancelled or failed, stay locked — user can tap again
    } catch {
      // Plugin error — stay locked
    } finally {
      setIsAuthenticating(false);
    }
  }, [isAuthenticating]);

  return { isLocked, isAuthenticating, unlock };
}
