import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import App from './App.tsx'
import { isNative } from './lib/platform'
import { initCapacitorListeners } from './lib/capacitorInit'

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
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
