import { isNative } from './platform';

type ImpactStyle = 'Heavy' | 'Medium' | 'Light';
type NotificationType = 'Success' | 'Warning' | 'Error';

let Haptics: any = null;
let lastHapticTime = 0;
const RATE_LIMIT_MS = 100;

// Lazy-load the Capacitor Haptics plugin on first use
async function getHaptics() {
  if (Haptics) return Haptics;
  if (!isNative()) return null;
  try {
    const mod = await import('@capacitor/haptics');
    Haptics = mod.Haptics;
    return Haptics;
  } catch {
    return null;
  }
}

function shouldThrottle(): boolean {
  const now = Date.now();
  if (now - lastHapticTime < RATE_LIMIT_MS) return true;
  lastHapticTime = now;
  return false;
}

async function impact(style: ImpactStyle) {
  if (shouldThrottle()) return;
  const h = await getHaptics();
  h?.impact({ style });
}

async function notification(type: NotificationType) {
  if (shouldThrottle()) return;
  const h = await getHaptics();
  h?.notification({ type });
}

async function selectionChanged() {
  if (shouldThrottle()) return;
  const h = await getHaptics();
  h?.selectionChanged();
}

export const haptic = {
  /** Light tap — tab switches, minor actions */
  light: () => impact('Light'),
  /** Medium tap — swipe threshold crossing */
  medium: () => impact('Medium'),
  /** Heavy tap — destructive actions */
  heavy: () => impact('Heavy'),
  /** Success — send complete, archive done */
  success: () => notification('Success'),
  /** Error — validation failure */
  error: () => notification('Error'),
  /** Warning — approaching threshold */
  warning: () => notification('Warning'),
  /** Selection change — picker scrolling */
  selection: () => selectionChanged(),
};
