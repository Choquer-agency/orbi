// ─────────────────────────────────────────────────────────────────────────────
// version.ts — "which build am I on?"
//
// The packaged Mac app loads its UI straight from Vercel, so the native shell
// and the interface move at completely different speeds:
//   • shell  — the .dmg a teammate installed. Changes rarely.
//   • UI     — redeployed by `npm run ship`, picked up on the next reload.
// The badge shows both, so when someone reports a bug we know exactly what
// they were running.
// ─────────────────────────────────────────────────────────────────────────────

declare const __UI_BUILD__: string;
declare const __UI_COMMIT__: string;

export function uiBuild(): string {
  return typeof __UI_BUILD__ !== 'undefined' ? __UI_BUILD__ : 'dev';
}

export function uiCommit(): string {
  return typeof __UI_COMMIT__ !== 'undefined' ? __UI_COMMIT__ : '';
}

interface ElectronBridge {
  getVersion?: () => Promise<string>;
  isElectron?: boolean;
}

function bridge(): ElectronBridge | undefined {
  return (window as unknown as { electronAPI?: ElectronBridge }).electronAPI;
}

export function isElectronShell(): boolean {
  return !!bridge()?.isElectron;
}

/** Native shell version, or null in a plain browser. */
export async function shellVersion(): Promise<string | null> {
  const api = bridge();
  if (!api?.getVersion) return null;
  try {
    return await api.getVersion();
  } catch {
    return null;
  }
}

/**
 * The build currently deployed to the server, identified by the hashed name
 * of the main JS bundle in index.html. When this differs from the bundle we
 * booted with, a newer UI has shipped and a reload will pick it up.
 */
export async function fetchDeployedBundleId(): Promise<string | null> {
  try {
    const res = await fetch(`/index.html?v=${Date.now()}`, { cache: 'no-store' });
    if (!res.ok) return null;
    const html = await res.text();
    const match = html.match(/assets\/index-[A-Za-z0-9_-]+\.js/);
    return match ? match[0] : null;
  } catch {
    // Offline, or running from file:// in the packaged fallback — not an error.
    return null;
  }
}

/** The bundle THIS window booted with, read from its own <script> tag. */
export function currentBundleId(): string | null {
  const scripts = Array.from(document.querySelectorAll('script[src]'));
  for (const s of scripts) {
    const src = s.getAttribute('src') ?? '';
    const match = src.match(/assets\/index-[A-Za-z0-9_-]+\.js/);
    if (match) return match[0];
  }
  return null;
}
