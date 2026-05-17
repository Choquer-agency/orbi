import { app, BrowserWindow, Tray, Menu, nativeImage, Notification, ipcMain, shell, session } from 'electron';
import path from 'path';
import { store } from './store';

const isDev = !app.isPackaged;
const VITE_DEV_SERVER_URL = 'http://localhost:5173';
const PROTOCOL = 'orbi-mail';

let mainWindow: BrowserWindow | null = null;
let tray: Tray | null = null;

function resolveAsset(...segments: string[]): string {
  return path.join(__dirname, '..', 'assets', ...segments);
}

function resolveFrontendIndex(): string {
  if (isDev) {
    return path.join(__dirname, '../../frontend/dist/index.html');
  }
  // In production, extraResource copies packages/frontend/dist → Contents/Resources/dist
  return path.join(process.resourcesPath, 'dist', 'index.html');
}

function createWindow() {
  const bounds = store.get('windowBounds');
  const isMaximized = store.get('isMaximized');

  mainWindow = new BrowserWindow({
    width: bounds.width,
    height: bounds.height,
    x: bounds.x,
    y: bounds.y,
    minWidth: 1024,
    minHeight: 680,
    titleBarStyle: 'hiddenInset',
    trafficLightPosition: { x: 16, y: 16 },
    icon: resolveAsset('icon.icns'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
    show: false,
  });

  if (isMaximized) {
    mainWindow.maximize();
  }

  mainWindow.once('ready-to-show', () => {
    mainWindow?.show();
  });

  if (isDev) {
    mainWindow.loadURL(VITE_DEV_SERVER_URL);
    mainWindow.webContents.openDevTools({ mode: 'detach' });
  } else {
    mainWindow.loadFile(resolveFrontendIndex());
  }

  mainWindow.on('close', () => {
    if (!mainWindow) return;
    const isMax = mainWindow.isMaximized();
    store.set('isMaximized', isMax);
    if (!isMax) {
      const [width, height] = mainWindow.getSize();
      const [x, y] = mainWindow.getPosition();
      store.set('windowBounds', { width, height, x, y });
    }
  });

  mainWindow.on('closed', () => {
    mainWindow = null;
  });

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: 'deny' };
  });

  // Belt-and-suspenders for OAuth: if any code navigates the main window away
  // from our dev server / packaged file, bounce it to the system browser
  // instead so the user can never get stranded on a third-party login page.
  mainWindow.webContents.on('will-navigate', (event, url) => {
    try {
      const target = new URL(url);
      const current = mainWindow?.webContents.getURL();
      const allowed =
        target.hostname === 'localhost' ||
        target.hostname === '127.0.0.1' ||
        target.protocol === 'file:' ||
        (current ? new URL(current).origin === target.origin : false);
      if (!allowed) {
        event.preventDefault();
        shell.openExternal(url);
      }
    } catch {
      // ignore
    }
  });
}

function createTray() {
  const trayIconPath = resolveAsset('trayTemplate.png');
  const icon = nativeImage.createFromPath(trayIconPath);
  icon.setTemplateImage(true);
  tray = new Tray(icon.isEmpty() ? nativeImage.createEmpty() : icon);

  const contextMenu = Menu.buildFromTemplate([
    {
      label: 'Show Orbi Mail',
      click: () => {
        mainWindow?.show();
        mainWindow?.focus();
      },
    },
    { type: 'separator' },
    {
      label: 'Quit',
      click: () => {
        app.quit();
      },
    },
  ]);

  tray.setToolTip('Orbi Mail');
  tray.setContextMenu(contextMenu);

  tray.on('click', () => {
    mainWindow?.show();
    mainWindow?.focus();
  });
}

if (process.defaultApp) {
  if (process.argv.length >= 2) {
    app.setAsDefaultProtocolClient(PROTOCOL, process.execPath, [path.resolve(process.argv[1])]);
  }
} else {
  app.setAsDefaultProtocolClient(PROTOCOL);
}

app.on('open-url', (event, url) => {
  event.preventDefault();
  handleDeepLink(url);
});

function handleDeepLink(url: string) {
  if (mainWindow) {
    mainWindow.webContents.send('deep-link', url);
    mainWindow.show();
    mainWindow.focus();
  }
}

ipcMain.handle('show-notification', (_event, title: string, body: string) => {
  if (Notification.isSupported()) {
    const notification = new Notification({ title, body });
    notification.on('click', () => {
      mainWindow?.show();
      mainWindow?.focus();
    });
    notification.show();
  }
});

ipcMain.handle('set-badge-count', (_event, count: number) => {
  app.setBadgeCount(count);
});

ipcMain.handle('get-platform', () => process.platform);
ipcMain.handle('get-version', () => app.getVersion());

ipcMain.handle('set-auto-launch', (_event, enabled: boolean) => {
  app.setLoginItemSettings({ openAtLogin: enabled });
  store.set('autoLaunch', enabled);
});

ipcMain.handle('get-auto-launch', () => store.get('autoLaunch'));

ipcMain.handle('open-external', (_event, url: string) => {
  // Renderer can ask us to bounce a URL out to the system browser. Used for
  // OAuth flows so the provider login page doesn't hijack the main window.
  try {
    const u = new URL(url);
    if (u.protocol === 'https:' || u.protocol === 'http:') {
      shell.openExternal(url);
    }
  } catch {
    // ignore non-URL strings
  }
});

const gotTheLock = app.requestSingleInstanceLock();
if (!gotTheLock) {
  app.quit();
} else {
  app.on('second-instance', (_event, argv) => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    }
    const deepLink = argv.find((arg) => arg.startsWith(`${PROTOCOL}://`));
    if (deepLink) {
      handleDeepLink(deepLink);
    }
  });
}

function installContentSecurityPolicy() {
  if (isDev) return;
  // Convex deployment URLs: .convex.cloud for WebSocket queries, .convex.site for HTTP actions.
  const convexCloud = process.env.CONVEX_URL || 'https://careful-warbler-543.convex.cloud';
  const convexSite = process.env.CONVEX_SITE_URL || 'https://careful-warbler-543.convex.site';
  const cloudHost = convexCloud.replace(/^https?:\/\//, '');
  session.defaultSession.webRequest.onHeadersReceived((details, callback) => {
    callback({
      responseHeaders: {
        ...details.responseHeaders,
        'Content-Security-Policy': [
          [
            "default-src 'self'",
            `connect-src 'self' ${convexCloud} ${convexSite} wss://${cloudHost}`,
            "img-src 'self' data: blob: https:",
            "style-src 'self' 'unsafe-inline'",
            "script-src 'self'",
            "font-src 'self' data:",
          ].join('; '),
        ],
      },
    });
  });
}

app.whenReady().then(() => {
  installContentSecurityPolicy();
  createWindow();
  createTray();

  const autoLaunch = store.get('autoLaunch');
  app.setLoginItemSettings({ openAtLogin: autoLaunch });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) {
    createWindow();
  }
});
