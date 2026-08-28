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
  server: {
    // Listen on every interface rather than loopback, so the dev server is
    // reachable from other machines on the network. Note what that means: this is
    // an unauthenticated dev server with hot reload and source maps, so only do it
    // on a network you trust.
    host: true,
    port: 5173,
    strictPort: true,
    // Vite refuses requests whose Host header is a name it does not recognise,
    // which is a DNS-rebinding guard rather than an inconvenience. Raw IP addresses
    // are allowed already; a leading dot allows a domain and its subdomains. Add an
    // entry here if you reach this through some other tunnel or a `.local` name —
    // and prefer naming it over `true`, which turns the guard off entirely.
    allowedHosts: ['.ts.net'],
  },
  build: {
    target: 'es2022',
    sourcemap: true,
  },
  test: {
    globals: true,
    environment: 'node',
    include: ['test/**/*.test.ts'],
    testTimeout: 30_000,
  },
});
