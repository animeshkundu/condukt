import { defineConfig } from 'vitest/config';

export default defineConfig({
  define: {
    'process.env.NODE_ENV': '"development"',
  },
  test: {
    include: ['__tests__/**/*.test.ts', '__tests__/**/*.test.tsx'],
    testTimeout: 30_000,
    hookTimeout: 10_000,
  },
});
