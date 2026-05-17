import { contextBridge, ipcRenderer } from 'electron';

contextBridge.exposeInMainWorld('electronAPI', {
  showNotification: (title: string, body: string) =>
    ipcRenderer.invoke('show-notification', title, body),

  setBadgeCount: (count: number) => ipcRenderer.invoke('set-badge-count', count),

  getPlatform: () => ipcRenderer.invoke('get-platform') as Promise<string>,

  getVersion: () => ipcRenderer.invoke('get-version') as Promise<string>,

  setAutoLaunch: (enabled: boolean) => ipcRenderer.invoke('set-auto-launch', enabled),

  getAutoLaunch: () => ipcRenderer.invoke('get-auto-launch') as Promise<boolean>,

  onDeepLink: (callback: (url: string) => void) => {
    ipcRenderer.on('deep-link', (_event, url: string) => callback(url));
  },

  // Opens a URL in the user's system browser. Used for OAuth flows so the
  // provider's login page never hijacks the Electron main window.
  openExternal: (url: string) => ipcRenderer.invoke('open-external', url),

  isElectron: true,
});
