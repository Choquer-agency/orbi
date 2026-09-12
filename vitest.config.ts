import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'edge-runtime',
    include: [
      'convex/**/*.test.ts',
      'packages/shared/src/**/*.test.ts',
      'packages/frontend/src/**/*.test.tsx',
    ],
  },
});
