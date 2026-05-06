const path = require('path');

const APPLE_ID = process.env.APPLE_ID;
const APPLE_PASSWORD = process.env.APPLE_APP_SPECIFIC_PASSWORD;
const APPLE_TEAM_ID = process.env.APPLE_TEAM_ID;
const SIGNING_IDENTITY = process.env.APPLE_SIGNING_IDENTITY;

const canSign = Boolean(SIGNING_IDENTITY);
const canNotarize = Boolean(APPLE_ID && APPLE_PASSWORD && APPLE_TEAM_ID);

module.exports = {
  packagerConfig: {
    name: 'Orbi Mail',
    executableName: 'Orbi Mail',
    appBundleId: 'com.orbimail.app',
    appCategoryType: 'public.app-category.productivity',
    icon: path.resolve(__dirname, 'assets/icon'),
    asar: true,
    extraResource: [path.resolve(__dirname, '../frontend/dist')],
    protocols: [{ name: 'Orbi Mail', schemes: ['orbi-mail'] }],
    osxSign: canSign
      ? {
          identity: SIGNING_IDENTITY,
          optionsForFile: () => ({
            hardenedRuntime: true,
            entitlements: path.resolve(__dirname, 'entitlements.mac.plist'),
            'entitlements-inherit': path.resolve(__dirname, 'entitlements.mac.plist'),
            'signature-flags': 'library',
          }),
        }
      : undefined,
    osxNotarize: canNotarize
      ? {
          appleId: APPLE_ID,
          appleIdPassword: APPLE_PASSWORD,
          teamId: APPLE_TEAM_ID,
        }
      : undefined,
  },
  rebuildConfig: {},
  makers: [
    {
      name: '@electron-forge/maker-dmg',
      config: {
        name: 'Orbi Mail',
        icon: path.resolve(__dirname, 'assets/icon.icns'),
        overwrite: true,
      },
    },
    {
      name: '@electron-forge/maker-zip',
      platforms: ['darwin'],
    },
  ],
  plugins: [],
};
