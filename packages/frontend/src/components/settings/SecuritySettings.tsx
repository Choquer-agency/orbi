import { useState, useEffect } from 'react';
import { Shield, Fingerprint, Clock } from 'lucide-react';
import { isNative } from '../../lib/platform';
import {
  checkBiometricAvailability,
  isLockEnabled,
  setLockEnabled,
  getGracePeriod,
  setGracePeriod,
  getBiometryLabel,
  authenticate,
  GRACE_PERIOD_OPTIONS,
  type BiometryType,
} from '../../lib/biometricLock';
import { cn } from '../../lib/utils';

export function SecuritySettings() {
  const [lockEnabled, setLockEnabledState] = useState(false);
  const [gracePeriodSeconds, setGracePeriodSeconds] = useState(0);
  const [biometryType, setBiometryType] = useState<BiometryType>('none');
  const [biometryAvailable, setBiometryAvailable] = useState(false);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!isNative()) {
      setLoading(false);
      return;
    }

    Promise.all([
      checkBiometricAvailability(),
      isLockEnabled(),
      getGracePeriod(),
    ]).then(([availability, enabled, period]) => {
      setBiometryAvailable(availability.available);
      setBiometryType(availability.biometryType);
      setLockEnabledState(enabled);
      setGracePeriodSeconds(period);
      setLoading(false);
    });
  }, []);

  const handleToggleLock = async () => {
    if (!lockEnabled) {
      // Turning ON: verify identity first
      const result = await authenticate('Confirm your identity to enable App Lock');
      if (!result.success) return;
    }

    const newValue = !lockEnabled;
    await setLockEnabled(newValue);
    setLockEnabledState(newValue);
  };

  const handleGracePeriodChange = async (seconds: number) => {
    await setGracePeriod(seconds);
    setGracePeriodSeconds(seconds);
  };

  if (!isNative()) {
    return (
      <div className="space-y-4">
        <div className="flex items-center gap-2">
          <Shield className="h-4 w-4 text-orange-500" />
          <h3 className="text-[13px] font-semibold text-text-primary">Security</h3>
        </div>
        <p className="text-xs text-text-tertiary">
          Security settings are available on the iOS app.
        </p>
      </div>
    );
  }

  if (loading) {
    return (
      <div className="flex items-center gap-2 py-4">
        <div className="h-4 w-4 animate-spin rounded-full border-2 border-primary border-t-transparent" />
        <span className="text-xs text-text-tertiary">Loading security settings...</span>
      </div>
    );
  }

  const biometryLabel = getBiometryLabel(biometryType);

  return (
    <div className="space-y-6">
      {/* App Lock toggle */}
      <div className="space-y-3">
        <div className="flex items-center gap-2">
          <Fingerprint className="h-4 w-4 text-orange-500" />
          <h3 className="text-[13px] font-semibold text-text-primary">App Lock</h3>
        </div>
        <p className="text-xs text-text-tertiary">
          Require {biometryAvailable ? biometryLabel : 'device passcode'} to unlock Orbi Mail after it has been in the background.
        </p>

        <button
          onClick={handleToggleLock}
          className="flex w-full items-center justify-between rounded-lg border border-border px-4 py-3 transition-colors hover:bg-surface"
        >
          <div className="flex items-center gap-3">
            <Fingerprint className="h-4 w-4 text-text-secondary" />
            <span className="text-[13px] text-text-primary">
              Require {biometryAvailable ? biometryLabel : 'Passcode'}
            </span>
          </div>
          <div
            className={cn(
              'relative h-[22px] w-[40px] rounded-full transition-colors',
              lockEnabled ? 'bg-primary' : 'bg-text-tertiary/30',
            )}
          >
            <div
              className={cn(
                'absolute top-[2px] h-[18px] w-[18px] rounded-full bg-white shadow-sm transition-transform',
                lockEnabled ? 'translate-x-[20px]' : 'translate-x-[2px]',
              )}
            />
          </div>
        </button>
      </div>

      {/* Grace period — only shown when lock is enabled */}
      {lockEnabled && (
        <div className="space-y-3">
          <div className="flex items-center gap-2">
            <Clock className="h-4 w-4 text-orange-500" />
            <h3 className="text-[13px] font-semibold text-text-primary">Require Authentication</h3>
          </div>
          <p className="text-xs text-text-tertiary">
            How long after leaving the app before {biometryLabel} is required again.
          </p>

          <div className="space-y-1">
            {GRACE_PERIOD_OPTIONS.map((option) => (
              <button
                key={option.value}
                onClick={() => handleGracePeriodChange(option.value)}
                className={cn(
                  'flex w-full items-center justify-between rounded-lg px-4 py-2.5 text-left text-[13px] transition-colors',
                  gracePeriodSeconds === option.value
                    ? 'bg-primary/8 font-medium text-primary'
                    : 'text-text-secondary hover:bg-surface',
                )}
              >
                {option.label}
                {gracePeriodSeconds === option.value && (
                  <div className="h-2 w-2 rounded-full bg-primary" />
                )}
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
