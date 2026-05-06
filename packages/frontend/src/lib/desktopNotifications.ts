declare global {
  interface Window {
    electronAPI?: {
      showNotification: (title: string, body: string) => Promise<void>;
      setBadgeCount: (count: number) => Promise<void>;
      getPlatform: () => Promise<string>;
      getVersion: () => Promise<string>;
      setAutoLaunch: (enabled: boolean) => Promise<void>;
      getAutoLaunch: () => Promise<boolean>;
      onDeepLink: (callback: (url: string) => void) => void;
      isElectron: boolean;
    };
  }
}

export function showDesktopNotification(title: string, body: string) {
  // Prefer Electron native notifications
  if (window.electronAPI?.isElectron) {
    window.electronAPI.showNotification(title, body);
    return;
  }

  // Fall back to browser Notification API
  if ('Notification' in window && Notification.permission === 'granted') {
    new Notification(title, { body });
  }
}

export function updateBadgeCount(count: number) {
  if (window.electronAPI?.isElectron) {
    window.electronAPI.setBadgeCount(count);
  }
}
