import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

/*
 * The site builds into `dist/` at the repository root, and `public/` is copied in alongside it —
 * which is where `fleet-demo.json` lives, the one file both the page and the API read.
 *
 * Nothing in here reaches the published package. `apollo` itself has no dependencies and no
 * build step; that is a claim the project makes and keeps. This directory is the website, it has
 * its own package.json, and `npm install` at the repository root still installs nothing at all.
 */
export default defineConfig({
  plugins: [react()],
  publicDir: '../public',
  build: {
    outDir: '../dist',
    emptyOutDir: true,
    assetsDir: 'assets',
  },
  server: {
    // `npm start` in the repository root; this proxies to it so the page is live against real data.
    proxy: { '/api': 'http://localhost:8791' },
  },
});
