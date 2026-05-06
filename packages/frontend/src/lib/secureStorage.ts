import { isNative } from './platform';
import type { StateStorage } from 'zustand/middleware';

/**
 * Zustand-compatible storage adapter that uses iOS Keychain (via Capacitor SecureStorage)
 * on native platforms and falls back to localStorage on web/Electron.
 *
 * Includes one-time migration from localStorage → Keychain for users upgrading
 * from web-only storage to native secure storage.
 */
export const secureStorage: StateStorage = {
  getItem: async (name: string): Promise<string | null> => {
    if (!isNative()) {
      return localStorage.getItem(name);
    }

    try {
      const { SecureStoragePlugin } = await import(
        'capacitor-secure-storage-plugin'
      );
      const { value } = await SecureStoragePlugin.get({ key: name });
      return value;
    } catch {
      // Key not found in Keychain — check localStorage for migration
      const localValue = localStorage.getItem(name);
      if (localValue) {
        try {
          const { SecureStoragePlugin } = await import(
            'capacitor-secure-storage-plugin'
          );
          await SecureStoragePlugin.set({ key: name, value: localValue });
          localStorage.removeItem(name);
        } catch {
          // Migration failed — still return the value from localStorage
        }
        return localValue;
      }
      return null;
    }
  },

  setItem: async (name: string, value: string): Promise<void> => {
    if (!isNative()) {
      localStorage.setItem(name, value);
      return;
    }

    try {
      const { SecureStoragePlugin } = await import(
        'capacitor-secure-storage-plugin'
      );
      await SecureStoragePlugin.set({ key: name, value });
    } catch {
      // Fall back to localStorage if SecureStorage fails
      localStorage.setItem(name, value);
    }
  },

  removeItem: async (name: string): Promise<void> => {
    if (!isNative()) {
      localStorage.removeItem(name);
      return;
    }

    try {
      const { SecureStoragePlugin } = await import(
        'capacitor-secure-storage-plugin'
      );
      await SecureStoragePlugin.remove({ key: name });
    } catch {
      // Key didn't exist or plugin failed
    }
    // Also clean up localStorage in case of migration remnants
    localStorage.removeItem(name);
  },
};
