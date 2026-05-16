import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { ConvexAuthProvider } from "@convex-dev/auth/react";
import { convex } from "./lib/convex";
import './index.css'
import App from './App.tsx'
import { ErrorBoundary } from './components/ErrorBoundary'
import { isNative } from './lib/platform'
import { initCapacitorListeners } from './lib/capacitorInit'

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <ErrorBoundary>
      <ConvexAuthProvider client={convex}>
        <App />
      </ConvexAuthProvider>
    </ErrorBoundary>
  </StrictMode>,
)

// Initialize Capacitor plugins and listeners on native platforms
initCapacitorListeners()

// Hide splash screen after React has mounted
if (isNative()) {
  import('@capacitor/splash-screen').then(({ SplashScreen }) => {
    SplashScreen.hide({ fadeOutDuration: 300 })
  })
}
