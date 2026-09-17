import { defineConfig } from 'vite';

// Multi-entry MV3 bundle. Outputs preserve names so manifest.json and the
// supervisor's offscreen URL stay stable: dist/sw.js, dist/offscreen.html,
// dist/sidepanel.html, dist/workspace.html.
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
        workspace: __dirname + '/src/workspace.html',
      },
      output: {
        entryFileNames: '[name].js',
        chunkFileNames: '[name].js',
        assetFileNames: '[name].[ext]',
      },
    },
  },
});
