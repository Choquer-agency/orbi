import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom';
import { Toaster } from 'react-hot-toast';
import { useAuthStore } from './stores/authStore';
import { LoginPage } from './components/auth/LoginPage';
import { AppLayout } from './components/layout/AppLayout';

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 1000 * 60,
      retry: 1,
    },
  },
});

function AuthenticatedApp() {
  const isAuthenticated = useAuthStore((s) => s.isAuthenticated);

  if (!isAuthenticated) {
    return <LoginPage />;
  }

  return <AppLayout />;
}

function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <BrowserRouter>
        <Routes>
          <Route path="/" element={<AuthenticatedApp />} />
          <Route path="/oauth/callback" element={<OAuthCallback />} />
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </BrowserRouter>
      <Toaster position="bottom-right" />
    </QueryClientProvider>
  );
}

function OAuthCallback() {
  const params = new URLSearchParams(window.location.search);
  const success = params.get('success') === 'true';
  const provider = params.get('provider');

  return (
    <div className="flex h-screen items-center justify-center">
      <div className="text-center">
        {success ? (
          <>
            <h2 className="text-lg font-semibold text-green-600">Account Connected!</h2>
            <p className="mt-1 text-sm text-gray-500">
              {provider} account has been linked successfully.
            </p>
          </>
        ) : (
          <>
            <h2 className="text-lg font-semibold text-red-600">Connection Failed</h2>
            <p className="mt-1 text-sm text-gray-500">Something went wrong. Please try again.</p>
          </>
        )}
        <a href="/" className="mt-4 inline-block text-sm text-blue-600 hover:underline">
          Go to inbox
        </a>
      </div>
    </div>
  );
}

export default App;
