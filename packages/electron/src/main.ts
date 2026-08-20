import { app, BrowserWindow, Tray, Menu, nativeImage, Notification, ipcMain, shell, session, dialog } from 'electron';
import path from 'path';
import fs from 'fs';
import { store } from './store';

const isDev = !app.isPackaged;
const VITE_DEV_SERVER_URL = 'http://localhost:5173';
const PROTOCOL = 'orbi-mail';
const DEFAULT_UPDATE_BASE_URL = 'https://pub-85d769e6aabd49f98c7cb117f4091639.r2.dev';

let mainWindow: BrowserWindow | null = null;
let tray: Tray | null = null;
let updateCheckStarted = false;
let promptedUpdateVersion: string | null = null;

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

function loadApp(window: BrowserWindow) {
  if (isDev) {
    window.loadURL(VITE_DEV_SERVER_URL);
  } else {
    window.loadFile(resolveFrontendIndex());
  }
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

  loadApp(mainWindow);
  if (isDev) {
    mainWindow.webContents.openDevTools({ mode: 'detach' });
  }

  mainWindow.webContents.on('before-input-event', (event, input) => {
    const isReload = input.key.toLowerCase() === 'r' && (input.meta || input.control);
    if (!isReload || input.type !== 'keyDown' || !mainWindow) return;
    event.preventDefault();
    loadApp(mainWindow);
  });

  mainWindow.webContents.on('did-fail-load', (_event, _code, _description, validatedURL) => {
    if (!mainWindow) return;
    if (!isDev && validatedURL !== `file://${resolveFrontendIndex()}`) {
      loadApp(mainWindow);
    }
  });

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

function getPackagedUpdateBaseUrl(): string | undefined {
  try {
    const packageJsonPath = path.join(app.getAppPath(), 'package.json');
    const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, 'utf8')) as { orbiUpdateBaseUrl?: string };
    return packageJson.orbiUpdateBaseUrl;
  } catch {
    return undefined;
  }
}

type ManualUpdateManifest = {
  version: string;
  name?: string;
  pub_date?: string;
  notes?: string;
  dmgUrl?: string;
  zipUrl?: string;
};

type SquirrelReleaseManifest = {
  currentRelease?: string;
  releases?: Array<{
    version: string;
    updateTo?: {
      version?: string;
      name?: string;
      url?: string;
      notes?: string;
      pub_date?: string;
    };
  }>;
};

function compareVersions(a: string, b: string): number {
  const aParts = a.split('.').map((part) => Number.parseInt(part, 10) || 0);
  const bParts = b.split('.').map((part) => Number.parseInt(part, 10) || 0);
  const length = Math.max(aParts.length, bParts.length);
  for (let i = 0; i < length; i++) {
    const diff = (aParts[i] ?? 0) - (bParts[i] ?? 0);
    if (diff !== 0) return diff;
  }
  return 0;
}

async function fetchJson<T>(url: string): Promise<T | null> {
  try {
    const response = await fetch(url, {
      headers: {
        'Cache-Control': 'no-cache',
        'User-Agent': `Orbi Mail/${app.getVersion()} (${process.platform}; ${process.arch})`,
      },
    });
    if (!response.ok) return null;
    return (await response.json()) as T;
  } catch (error) {
    console.warn('[manual-update] fetch failed', error);
    return null;
  }
}

function releaseManifestToManualUpdate(
  manifest: SquirrelReleaseManifest | null,
): ManualUpdateManifest | null {
  if (!manifest?.currentRelease) return null;
  const current = manifest.releases?.find(
    (release) => release.version === manifest.currentRelease,
  ) ?? manifest.releases?.at(-1);
  const updateTo = current?.updateTo;
  if (!updateTo?.url) return null;
  return {
    version: updateTo.version || current?.version || manifest.currentRelease,
    name: updateTo.name,
    notes: updateTo.notes,
    pub_date: updateTo.pub_date,
    zipUrl: updateTo.url,
  };
}

async function checkForManualUpdate(baseUrl: string) {
  const base = baseUrl.replace(/\/$/, '');
  const archBase = `${base}/${process.platform}/${process.arch}`;
  const manual = await fetchJson<ManualUpdateManifest>(`${archBase}/manual.json`);
  const fallback = manual ?? releaseManifestToManualUpdate(
    await fetchJson<SquirrelReleaseManifest>(`${archBase}/RELEASES.json`),
  );

  if (!fallback?.version) return;
  if (compareVersions(fallback.version, app.getVersion()) <= 0) return;
  if (promptedUpdateVersion === fallback.version) return;

  promptedUpdateVersion = fallback.version;
  const downloadUrl = fallback.dmgUrl || fallback.zipUrl;
  if (!downloadUrl) return;

  const prompt = mainWindow
    ? dialog.showMessageBox(mainWindow, {
        type: 'info',
        buttons: ['Download update', 'Later'],
        defaultId: 0,
        cancelId: 1,
        title: 'Update available',
        message: `Orbi Mail ${fallback.version} is available`,
        detail:
          'Because this build is unsigned, macOS requires a manual install. Download the installer, quit Orbi Mail, then replace the app in Applications.',
      })
    : dialog.showMessageBox({
        type: 'info',
        buttons: ['Download update', 'Later'],
        defaultId: 0,
        cancelId: 1,
        title: 'Update available',
        message: `Orbi Mail ${fallback.version} is available`,
        detail:
          'Because this build is unsigned, macOS requires a manual install. Download the installer, quit Orbi Mail, then replace the app in Applications.',
      });

  const result = await prompt;
  if (result.response === 0) {
    await shell.openExternal(downloadUrl);
  }
}

function configureAutoUpdates() {
  if (isDev || updateCheckStarted) return;

  // Free/unsigned update flow: detect new releases hosted on Cloudflare R2 and
  // open the DMG/ZIP for manual install. True auto-install requires signed and
  // notarized macOS builds.
  const staticBaseUrl = process.env.ORBI_UPDATE_BASE_URL || getPackagedUpdateBaseUrl() || DEFAULT_UPDATE_BASE_URL;
  if (!staticBaseUrl) return;

  updateCheckStarted = true;
  const runCheck = () => {
    void checkForManualUpdate(staticBaseUrl);
  };

  setTimeout(runCheck, 3_000);
  setInterval(runCheck, 60 * 60 * 1000);
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

// One-click "Save email as PDF" (invoices → accountant, Bryce 2026-07-28).
// Renders the passed HTML in a hidden window and writes the PDF straight to
// ~/Downloads — no dialogs, dock bounce + notification on completion.
ipcMain.handle('save-email-pdf', async (_event, html: string, baseName: string) => {
  const safe = (baseName || 'email')
    .replace(/[/\\:*?"<>|]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 120) || 'email';
  const downloadsDir = app.getPath('downloads');
  let target = path.join(downloadsDir, `${safe}.pdf`);
  let n = 2;
  while (fs.existsSync(target)) {
    target = path.join(downloadsDir, `${safe} ${n}.pdf`);
    n++;
  }
  const tmp = path.join(app.getPath('temp'), `orbi-pdf-${Date.now()}.html`);
  const win = new BrowserWindow({
    show: false,
    webPreferences: { sandbox: true, javascript: false },
  });
  try {
    fs.writeFileSync(tmp, html, 'utf8');
    await win.loadFile(tmp);
    // Give remote images a moment to arrive before rasterizing.
    await new Promise((r) => setTimeout(r, 600));
    const pdf = await win.webContents.printToPDF({
      printBackground: true,
      margins: { top: 0.4, bottom: 0.4, left: 0.4, right: 0.4 },
    });
    fs.writeFileSync(target, pdf);
    if (process.platform === 'darwin') {
      app.dock?.downloadFinished(target);
    }
    if (Notification.isSupported()) {
      const note = new Notification({
        title: 'PDF saved to Downloads',
        body: path.basename(target),
      });
      note.on('click', () => shell.showItemInFolder(target));
      note.show();
    }
    return { ok: true, path: target };
  } catch (err) {
    console.error('[save-email-pdf] failed', err);
    return { ok: false, error: String(err) };
  } finally {
    win.destroy();
    try { fs.rmSync(tmp); } catch { /* already gone */ }
  }
});

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
            // 'unsafe-inline' is required so our email-viewer iframe can run
            // its inline bootstrap script (height + link/image proxy). The
            // iframe is sandboxed without `allow-same-origin`, so its script
            // runs in an opaque origin and cannot access the parent app or
            // cookies — the sandbox is the real security boundary here.
            "script-src 'self' 'unsafe-inline'",
            // srcdoc iframes inherit the parent CSP unless explicitly
            // overridden. Re-state script-src for child srcdoc frames so
            // the bootstrap is allowed there too.
            "frame-src 'self'",
            "font-src 'self' data:",
          ].join('; '),
        ],
      },
    });
  });
}

function installDownloadHandler() {
  // Attachment/image downloads: the renderer triggers a normal Chromium
  // download (blob + <a download>). Without this handler the shell had no
  // download pipeline wired up, so clicks did nothing. Save straight to
  // ~/Downloads with no dialog (Bryce 2026-07-13), dedupe filenames, and
  // confirm with the macOS Downloads-stack bounce + a notification.
  session.defaultSession.on('will-download', (_event, item) => {
    const downloadsDir = app.getPath('downloads');
    const base = item.getFilename() || 'download';
    const ext = path.extname(base);
    const stem = ext ? base.slice(0, -ext.length) : base;
    let target = path.join(downloadsDir, base);
    let n = 2;
    while (fs.existsSync(target)) {
      target = path.join(downloadsDir, `${stem} ${n}${ext}`);
      n++;
    }
    item.setSavePath(target);
    item.once('done', (_e, state) => {
      if (state === 'completed') {
        if (process.platform === 'darwin') {
          app.dock?.downloadFinished(target);
        }
        if (Notification.isSupported()) {
          const note = new Notification({
            title: 'Saved to Downloads',
            body: path.basename(target),
          });
          note.on('click', () => shell.showItemInFolder(target));
          note.show();
        }
      } else if (state !== 'cancelled' && Notification.isSupported()) {
        new Notification({ title: 'Download failed', body: base }).show();
      }
    });
  });
}

app.whenReady().then(() => {
  // Dev-mode Electron ships its own dock icon; replace it with the Orbi
  // logo tile so the dock shows the brand in dev too (packaged builds get
  // it via assets/icon.icns).
  if (process.platform === 'darwin') {
    try {
      app.dock?.setIcon(nativeImage.createFromPath(resolveAsset('icon-1024.png')));
    } catch {
      /* asset missing — default icon stands */
    }
  }
  installContentSecurityPolicy();
  installDownloadHandler();
  createWindow();
  createTray();
  configureAutoUpdates();

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
