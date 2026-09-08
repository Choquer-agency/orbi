import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import path from 'path';

// Stamped into the bundle so every teammate can see — and report — exactly
// which build they are on. The packaged Mac app loads the UI from Vercel, so
// "which version am I running" is otherwise invisible (Bryce 2026-09-08).
const UI_BUILD = new Date().toLocaleString('en-US', {
  month: 'short',
  day: 'numeric',
  hour: 'numeric',
  minute: '2-digit',
  timeZone: 'America/Vancouver',
});
const UI_COMMIT = (process.env.VERCEL_GIT_COMMIT_SHA ?? '').slice(0, 7);

export default defineConfig(({ mode }) => ({
  base: mode === 'ios' || mode === 'electron' ? './' : '/',
  define: {
    __UI_BUILD__: JSON.stringify(UI_BUILD),
    __UI_COMMIT__: JSON.stringify(UI_COMMIT),
  },
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
      '@convex': path.resolve(__dirname, '../../convex'),
    },
  },
  optimizeDeps: {
    include: [
      'react',
      'react-dom',
      'react-router-dom',
      '@tanstack/react-query',
      'zustand',
      'zustand/middleware',
      'lucide-react',
      'react-hot-toast',
      'dompurify',
      'clsx',
      'tailwind-merge',
    ],
  },
  server: {
    port: 5173,
    proxy: {
      '/api': {
        target: 'http://localhost:3001',
        changeOrigin: true,
      },
      '/socket.io': {
        target: 'http://localhost:3001',
        ws: true,
      },
    },
  },
}));
