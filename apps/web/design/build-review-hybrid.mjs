import { fileURLToPath, URL } from 'node:url';
import { build } from '../node_modules/vite/dist/node/index.js';
import react from '../node_modules/@vitejs/plugin-react/dist/index.js';

// Build only the design fixture. The production entry and its config stay separate.
await build({
  configFile: false,
  root: fileURLToPath(new URL('.', import.meta.url)),
  base: './',
  plugins: [react()],
  build: {
    outDir: fileURLToPath(
      new URL('../../../docs/design/review-ui-proposals-2026-09-27/hybrid-build/', import.meta.url),
    ),
    emptyOutDir: true,
    rollupOptions: {
      input: fileURLToPath(new URL('./review-hybrid.html', import.meta.url)),
    },
  },
});
