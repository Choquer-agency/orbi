import { isNative, isIOS } from './platform';

export async function initCapacitorListeners() {
  if (!isNative()) return;

  const { App: CapApp } = await import('@capacitor/app');
  const { Browser } = await import('@capacitor/browser');

  // App lifecycle — foreground / background handling
  CapApp.addListener('appStateChange', ({ isActive }) => {
    if (isActive) {
      // Force socket reconnect + query refresh
      window.dispatchEvent(new CustomEvent('app-foreground'));
      // Reset potentially stale keyboard height
      document.documentElement.style.setProperty('--keyboard-height', '0px');
    } else {
      // Signal compose to save drafts immediately
      window.dispatchEvent(new CustomEvent('app-background'));
    }
  });

  // Deep link listener — intercepts orbi-mail:// URL scheme, Universal Links, and Quick Actions
  CapApp.addListener('appUrlOpen', async ({ url }) => {
    Browser.close();
    try {
      const parsed = new URL(url);
      // Custom URL scheme: orbi-mail://compose → path = /compose
      // Universal Links: https://app.orbimail.com/thread/abc → path = /thread/abc
      const path = parsed.pathname.replace(/^\/\//, '/');
      window.dispatchEvent(
        new CustomEvent('capacitor-deeplink', {
          detail: { path, search: parsed.search },
        }),
      );
    } catch {
      // Malformed URL — ignore
    }
  });

  // Keyboard handling — expose keyboard height as CSS variable
  if (isIOS()) {
    const { Keyboard } = await import('@capacitor/keyboard');
    Keyboard.addListener('keyboardWillShow', (info) => {
      document.documentElement.style.setProperty('--keyboard-height', `${info.keyboardHeight}px`);
    });
    Keyboard.addListener('keyboardWillHide', () => {
      document.documentElement.style.setProperty('--keyboard-height', '0px');
    });
  }

  // Status bar styling
  if (isIOS()) {
    const { StatusBar, Style } = await import('@capacitor/status-bar');
    StatusBar.setStyle({ style: Style.Light });
  }
}
