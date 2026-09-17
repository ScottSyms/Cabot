import { defineConfig } from 'vite';

// Multi-entry MV3 bundle. Outputs preserve names so manifest.json and the
// supervisor's offscreen URL stay stable: dist/service-worker/entry.js,
// dist/offscreen/offscreen.html, dist/sidepanel/sidepanel.html.
export default defineConfig({
  root: __dirname + '/src',
  base: './',
  build: {
    outDir: __dirname + '/dist',
    emptyOutDir: true,
    target: 'es2022',
    minify: false,
    rollupOptions: {
      input: {
        sw: __dirname + '/src/service-worker/entry.ts',
        offscreen: __dirname + '/src/offscreen.html',
        sidepanel: __dirname + '/src/sidepanel.html',
      },
      output: {
        entryFileNames: '[name].js',
        chunkFileNames: '[name].js',
        assetFileNames: '[name].[ext]',
      },
    },
  },
});
