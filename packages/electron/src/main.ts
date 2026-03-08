import { app, BrowserWindow, Tray, Menu, nativeImage, Notification, ipcMain, shell } from 'electron';
import path from 'path';
import Store from 'electron-store';

const store = new Store({
  defaults: {
    windowBounds: { width: 1400, height: 900, x: undefined as number | undefined, y: undefined as number | undefined },
    isMaximized: false,
    autoLaunch: false,
  },
});

const isDev = process.env.NODE_ENV !== 'production' || !app.isPackaged;
const VITE_DEV_SERVER_URL = 'http://localhost:5173';
const PROTOCOL = 'orbi-mail';

let mainWindow: BrowserWindow | null = null;
let tray: Tray | null = null;

function createWindow() {
  const bounds = store.get('windowBounds') as { width: number; height: number; x?: number; y?: number };
  const isMaximized = store.get('isMaximized') as boolean;

  mainWindow = new BrowserWindow({
    width: bounds.width,
    height: bounds.height,
    x: bounds.x,
    y: bounds.y,
    minWidth: 1024,
    minHeight: 680,
    titleBarStyle: 'hiddenInset',
    trafficLightPosition: { x: 16, y: 16 },
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
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
    mainWindow.webContents.openDevTools();
  } else {
    mainWindow.loadFile(path.join(__dirname, '../frontend/dist/index.html'));
  }

  // Save window state on close
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

  // Open external links in default browser
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: 'deny' };
  });
}

function createTray() {
  // Use a simple template icon for the tray
  const icon = nativeImage.createEmpty();
  tray = new Tray(icon);

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

// Register custom protocol for OAuth callbacks
if (process.defaultApp) {
  if (process.argv.length >= 2) {
    app.setAsDefaultProtocolClient(PROTOCOL, process.execPath, [path.resolve(process.argv[1])]);
  }
} else {
  app.setAsDefaultProtocolClient(PROTOCOL);
}

// Handle deep links (macOS)
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

// IPC handlers
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

ipcMain.handle('get-platform', () => {
  return process.platform;
});

ipcMain.handle('get-version', () => {
  return app.getVersion();
});

ipcMain.handle('set-auto-launch', (_event, enabled: boolean) => {
  app.setLoginItemSettings({ openAtLogin: enabled });
  store.set('autoLaunch', enabled);
});

ipcMain.handle('get-auto-launch', () => {
  return store.get('autoLaunch');
});

// Single instance lock
const gotTheLock = app.requestSingleInstanceLock();
if (!gotTheLock) {
  app.quit();
} else {
  app.on('second-instance', (_event, argv) => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    }
    // Handle deep link on Windows/Linux
    const deepLink = argv.find((arg) => arg.startsWith(`${PROTOCOL}://`));
    if (deepLink) {
      handleDeepLink(deepLink);
    }
  });
}

app.whenReady().then(() => {
  createWindow();
  createTray();

  // Apply auto-launch setting
  const autoLaunch = store.get('autoLaunch') as boolean;
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
