import { useEffect, useState } from 'react';
import { RefreshCw } from 'lucide-react';
import {
  uiBuild,
  uiCommit,
  shellVersion,
  currentBundleId,
  fetchDeployedBundleId,
} from '../../lib/version';

// How often to ask the server whether a newer UI has shipped. The check is a
// single cached-bypassed GET of index.html (~2 KB), so this is cheap.
const POLL_MS = 2 * 60 * 1000;

/**
 * Bottom-left build badge.
 *
 * Two jobs:
 *  1. Tell everyone which build they are on, so bug reports are anchored to a
 *     version instead of "it was broken this morning".
 *  2. Notice when a newer UI has been deployed and offer a one-click reload —
 *     the packaged app streams its UI from Vercel, so shipping is instant but
 *     an open window keeps whatever it booted with until it reloads.
 */
export function VersionBadge() {
  const [shell, setShell] = useState<string | null>(null);
  const [updateReady, setUpdateReady] = useState(false);

  useEffect(() => {
    let alive = true;
    shellVersion().then((v) => {
      if (alive) setShell(v);
    });
    return () => {
      alive = false;
    };
  }, []);

  useEffect(() => {
    const booted = currentBundleId();
    // In dev there is no hashed bundle — Vite serves modules directly.
    if (!booted) return;
    let alive = true;
    const check = async () => {
      const deployed = await fetchDeployedBundleId();
      if (alive && deployed && deployed !== booted) setUpdateReady(true);
    };
    const id = setInterval(check, POLL_MS);
    // Also check whenever the window regains focus — the common case is
    // someone coming back to Orbi after a deploy went out.
    const onFocus = () => void check();
    window.addEventListener('focus', onFocus);
    void check();
    return () => {
      alive = false;
      clearInterval(id);
      window.removeEventListener('focus', onFocus);
    };
  }, []);

  const commit = uiCommit();
  const label = `${shell ? `v${shell}` : 'web'} · ${uiBuild()}${commit ? ` · ${commit}` : ''}`;

  if (updateReady) {
    return (
      <button
        onClick={() => window.location.reload()}
        className="pointer-events-auto flex items-center gap-1.5 rounded-full bg-primary/90 px-2.5 py-1 text-[10px] font-medium text-white shadow-sm transition-colors hover:bg-primary"
        title={`A newer build is available. You are on ${label}.`}
      >
        <RefreshCw className="h-2.5 w-2.5" />
        Update ready — click to reload
      </button>
    );
  }

  return (
    <button
      onClick={() => window.location.reload()}
      className="pointer-events-auto select-none px-1 py-0.5 text-[10px] text-text-tertiary/70 transition-colors hover:text-text-secondary"
      title="App version · interface build. Click to reload and pull the latest."
    >
      {label}
    </button>
  );
}
