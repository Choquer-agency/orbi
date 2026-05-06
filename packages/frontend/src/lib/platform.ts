export type Platform = 'ios' | 'android' | 'electron' | 'web';

export function getPlatform(): Platform {
  if (typeof window !== 'undefined') {
    // Capacitor injects window.Capacitor before any JS runs in the native shell
    if ((window as any).Capacitor?.isNativePlatform?.()) {
      return (window as any).Capacitor.getPlatform() as 'ios' | 'android';
    }
    if ((window as any).electronAPI?.isElectron) {
      return 'electron';
    }
  }
  return 'web';
}

export const isNative = () => ['ios', 'android'].includes(getPlatform());
export const isIOS = () => getPlatform() === 'ios';
export const isElectron = () => getPlatform() === 'electron';
export const isWeb = () => getPlatform() === 'web';
