import { QueryClient, MutationCache, onlineManager, useQueryClient } from '@tanstack/react-query';
import { PersistQueryClientProvider } from '@tanstack/react-query-persist-client';
import { BrowserRouter, Routes, Route, Navigate, useNavigate } from 'react-router-dom';
import { useEffect } from 'react';
import toast, { Toaster } from 'react-hot-toast';
import { useAuthStore } from './stores/authStore';
import { useUiStore } from './stores/uiStore';
import { LoginPage } from './components/auth/LoginPage';
import { AppLayout } from './components/layout/AppLayout';
import { ErrorBoundary } from './components/ErrorBoundary';
import { offlinePersister } from './lib/offlineStorage';
import { isNative } from './lib/platform';

// Wire TanStack Query's online manager to native or browser events
onlineManager.setEventListener((setOnline) => {
  if (isNative()) {
    let cleanup: (() => void) | undefined;
    import('@capacitor/network').then(({ Network }) => {
      Network.addListener('networkStatusChange', (status) => {
        setOnline(status.connected);
      });
      cleanup = () => { Network.removeAllListeners(); };
    });
    return () => cleanup?.();
  }

  // Web / Electron: browser events
  const onOnline = () => setOnline(true);
  const onOffline = () => setOnline(false);
  window.addEventListener('online', onOnline);
  window.addEventListener('offline', onOffline);
  return () => {
    window.removeEventListener('online', onOnline);
    window.removeEventListener('offline', onOffline);
  };
});

const queryClient = new QueryClient({
  mutationCache: new MutationCache({
    onMutate: () => {
      if (!navigator.onLine) {
        toast.error("You're offline. This action will be available when you reconnect.");
        throw new Error('offline');
      }
    },
  }),
  defaultOptions: {
    queries: {
      staleTime: 1000 * 30,
      refetchOnWindowFocus: true,
      retry: 1,
      networkMode: 'offlineFirst',
    },
  },
});

const CACHE_MAX_AGE = 7 * 24 * 60 * 60 * 1000; // 7 days

const persistOptions = {
  persister: offlinePersister,
  maxAge: CACHE_MAX_AGE,
  dehydrateOptions: {
    shouldDehydrateQuery: (query: { queryKey: ReadonlyArray<unknown> }) => {
      const key = query.queryKey[0];
      return key === 'threads' || key === 'thread' || key === 'accounts';
    },
  },
};

function AuthenticatedApp() {
  const isAuthenticated = useAuthStore((s) => s.isAuthenticated);

  if (!isAuthenticated) {
    return <LoginPage />;
  }

  return (
    <ErrorBoundary>
      <AppLayout />
    </ErrorBoundary>
  );
}

function CapacitorDeepLinkHandler() {
  const navigate = useNavigate();

  useEffect(() => {
    const handler = (e: Event) => {
      const { path, search } = (e as CustomEvent).detail;
      const store = useUiStore.getState();

      // Handle Quick Action and Universal Link paths
      if (path === '/compose') {
        store.setComposingNew(true);
        return;
      }
      if (path === '/search') {
        store.setSelectedFolder('inbox');
        // Dispatch search focus event for ThreadList to pick up
        window.dispatchEvent(new CustomEvent('focus-search'));
        return;
      }
      if (path === '/inbox') {
        store.setSelectedFolder('inbox');
        return;
      }
      if (path.startsWith('/thread/')) {
        const threadId = path.replace('/thread/', '');
        if (threadId) {
          store.setSelectedThread(threadId);
          return;
        }
      }

      // OAuth callbacks and other routes — use React Router
      if (path === '/oauth/callback') {
        navigate(`${path}${search}`, { replace: true });
        return;
      }
    };
    window.addEventListener('capacitor-deeplink', handler);
    return () => window.removeEventListener('capacitor-deeplink', handler);
  }, [navigate]);

  return null;
}

function App() {
  return (
    <PersistQueryClientProvider client={queryClient} persistOptions={persistOptions}>
      <BrowserRouter>
        <CapacitorDeepLinkHandler />
        <Routes>
          <Route path="/oauth/callback" element={<OAuthCallback />} />
          <Route path="/" element={<AuthenticatedApp />} />
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </BrowserRouter>
      <Toaster position={window.matchMedia('(max-width: 899px)').matches ? 'top-center' : 'bottom-right'} />
    </PersistQueryClientProvider>
  );
}

function OAuthCallback() {
  const params = new URLSearchParams(window.location.search);
  const success = params.get('success') === 'true';
  const provider = params.get('provider');
  const navigate = useNavigate();
  const queryClient = useQueryClient();

  // Invalidate accounts cache and redirect after success
  useEffect(() => {
    if (success) {
      queryClient.invalidateQueries({ queryKey: ['accounts'] });
      queryClient.invalidateQueries({ queryKey: ['threads'] });
      const timer = setTimeout(() => navigate('/', { replace: true }), 2000);
      return () => clearTimeout(timer);
    }
  }, [success, navigate, queryClient]);

  return (
    <div className="flex h-screen items-center justify-center ai-gradient-bg">
      <div className="rounded-lg bg-white/80 p-8 text-center shadow-sm backdrop-blur-sm">
        {success ? (
          <>
            <h2 className="text-lg font-semibold text-green-600">Account Connected!</h2>
            <p className="mt-2 text-sm text-gray-500">
              Your {provider === 'gmail' ? 'Gmail' : 'Microsoft'} account has been linked. Syncing your emails now...
            </p>
            <p className="mt-1 text-xs text-gray-400">Redirecting to inbox...</p>
          </>
        ) : (
          <>
            <h2 className="text-lg font-semibold text-red-600">Connection Failed</h2>
            <p className="mt-2 text-sm text-gray-500">Something went wrong. Please try again.</p>
            <button onClick={() => navigate('/', { replace: true })} className="mt-4 inline-block text-sm text-blue-600 hover:underline">
              Go to inbox
            </button>
          </>
        )}
      </div>
    </div>
  );
}

export default App;
