import { isNative } from './platform';
import { registerPlugin } from '@capacitor/core';

interface BiometricPluginInterface {
  isAvailable(): Promise<{
    available: boolean;
    biometryType: 'faceId' | 'touchId' | 'opticId' | 'none' | 'unknown';
    passcodeAvailable: boolean;
  }>;
  authenticate(options: { reason?: string }): Promise<{
    success: boolean;
    cancelled?: boolean;
    errorCode?: number;
  }>;
  getBackgroundTimestamp(): Promise<{ timestamp: number }>;
  setLockEnabled(options: { enabled: boolean }): Promise<void>;
  isLockEnabled(): Promise<{ enabled: boolean }>;
  setGracePeriod(options: { seconds: number }): Promise<void>;
  getGracePeriod(): Promise<{ seconds: number }>;
}

const BiometricPlugin = registerPlugin<BiometricPluginInterface>('BiometricPlugin');

export type BiometryType = 'faceId' | 'touchId' | 'opticId' | 'none' | 'unknown';

export const GRACE_PERIOD_OPTIONS = [
  { label: 'Immediately', value: 0 },
  { label: 'After 1 minute', value: 60 },
  { label: 'After 5 minutes', value: 300 },
  { label: 'After 15 minutes', value: 900 },
] as const;

/**
 * Check if biometric authentication is available on this device
 */
export async function checkBiometricAvailability() {
  if (!isNative()) {
    return { available: false, biometryType: 'none' as BiometryType, passcodeAvailable: false };
  }
  return BiometricPlugin.isAvailable();
}

/**
 * Trigger biometric authentication (Face ID / Touch ID with passcode fallback)
 */
export async function authenticate(reason?: string) {
  if (!isNative()) return { success: false, cancelled: false };
  return BiometricPlugin.authenticate({ reason: reason ?? 'Unlock Orbi Mail' });
}

/**
 * Check if enough time has passed since backgrounding to require re-auth
 */
export async function shouldRequireAuth(): Promise<boolean> {
  if (!isNative()) return false;

  const { enabled } = await BiometricPlugin.isLockEnabled();
  if (!enabled) return false;

  const { timestamp } = await BiometricPlugin.getBackgroundTimestamp();
  if (timestamp === 0) return false; // App hasn't been backgrounded yet

  const { seconds: gracePeriod } = await BiometricPlugin.getGracePeriod();
  const elapsed = Date.now() / 1000 - timestamp;

  return elapsed >= gracePeriod;
}

/**
 * Enable/disable the biometric lock
 */
export async function setLockEnabled(enabled: boolean) {
  if (!isNative()) return;
  return BiometricPlugin.setLockEnabled({ enabled });
}

/**
 * Get current lock enabled state
 */
export async function isLockEnabled() {
  if (!isNative()) return false;
  const { enabled } = await BiometricPlugin.isLockEnabled();
  return enabled;
}

/**
 * Set the grace period before re-authentication is required
 */
export async function setGracePeriod(seconds: number) {
  if (!isNative()) return;
  return BiometricPlugin.setGracePeriod({ seconds });
}

/**
 * Get current grace period
 */
export async function getGracePeriod() {
  if (!isNative()) return 0;
  const { seconds } = await BiometricPlugin.getGracePeriod();
  return seconds;
}

/**
 * Human-friendly label for biometry type
 */
export function getBiometryLabel(type: BiometryType): string {
  switch (type) {
    case 'faceId': return 'Face ID';
    case 'touchId': return 'Touch ID';
    case 'opticId': return 'Optic ID';
    default: return 'Biometrics';
  }
}
