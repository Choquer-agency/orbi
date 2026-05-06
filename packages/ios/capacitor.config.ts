import type { CapacitorConfig } from '@capacitor/cli';

const config: CapacitorConfig = {
  appId: 'com.orbimail.app',
  appName: 'Orbi Mail',
  webDir: '../frontend/dist',
  plugins: {
    SplashScreen: {
      launchAutoHide: false,
      backgroundColor: '#FAF9F5',
    },
    Keyboard: {
      resize: 'ionic',
      resizeOnFullScreen: true,
    },
  },
  server: {
    url: 'http://192.168.0.225:5173',
    cleartext: true,
  },
  ios: {
    scheme: 'Orbi Mail',
    contentInset: 'always',
  },
};

export default config;
