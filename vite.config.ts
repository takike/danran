import { fileURLToPath } from 'node:url';
import { cloudflare } from '@cloudflare/vite-plugin';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

export default defineConfig({
  plugins: [react(), cloudflare()],
  resolve: {
    alias: {
      '@client': fileURLToPath(new URL('./src/client', import.meta.url)),
      '@worker': fileURLToPath(new URL('./src/worker', import.meta.url)),
      '@shared': fileURLToPath(new URL('./src/shared', import.meta.url)),
    },
  },
});
