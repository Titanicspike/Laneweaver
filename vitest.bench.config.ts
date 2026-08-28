import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';

const r = (p: string) => fileURLToPath(new URL(p, import.meta.url));

export default defineConfig({
  resolve: {
    alias: {
      '@core': r('./src/core'),
      '@render': r('./src/render'),
      '@editor': r('./src/editor'),
      '@app': r('./src/app'),
    },
  },
  test: {
    globals: true,
    environment: 'node',
    include: ['bench/**/*.bench.ts'],
    // A benchmark that hides its own numbers is not a benchmark.
    disableConsoleIntercept: true,
    testTimeout: 300_000,
    hookTimeout: 120_000,
  },
});
