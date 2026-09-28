import { fileURLToPath } from 'node:url';
import { cloudflare } from '@cloudflare/vite-plugin';
import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { type Plugin, defineConfig } from 'vite';
import { VitePWA } from 'vite-plugin-pwa';

const pwaPlugins: Plugin[] = VitePWA({
  strategies: 'generateSW',
  registerType: 'autoUpdate',
  injectRegister: 'auto',
  outDir: 'dist/client',
  scope: '/',
  base: '/',
  manifest: {
    id: '/',
    start_url: '/',
    scope: '/',
    name: 'Danran',
    short_name: 'だんらん',
    description: 'ルーティンは背景に、週末は前景に。家族の時間を守るカレンダー。',
    display: 'standalone',
    orientation: 'portrait',
    background_color: '#f6f3ee',
    theme_color: '#f6f3ee',
    lang: 'ja',
    dir: 'ltr',
    icons: [
      {
        src: '/icons/icon-192.png',
        sizes: '192x192',
        type: 'image/png',
        purpose: 'any',
      },
      {
        src: '/icons/icon-512.png',
        sizes: '512x512',
        type: 'image/png',
        purpose: 'any',
      },
      {
        src: '/icons/icon-512-maskable.png',
        sizes: '512x512',
        type: 'image/png',
        purpose: 'maskable',
      },
    ],
  },
  workbox: {
    globDirectory: 'dist/client',
    globPatterns: ['**/*.{js,css,html,ico,png,svg,webmanifest}'],
    navigateFallback: '/index.html',
    navigateFallbackDenylist: [/^\/api(?:\/|$)/],
    cleanupOutdatedCaches: true,
    runtimeCaching: [],
  },
  devOptions: {
    enabled: false,
  },
}).map(
  (plugin): Plugin => ({
    ...plugin,
    applyToEnvironment(environment) {
      return environment.name === 'client';
    },
  }),
);

export default defineConfig({
  plugins: [tailwindcss(), react(), cloudflare(), ...pwaPlugins],
  resolve: {
    alias: {
      '@client': fileURLToPath(new URL('./src/client', import.meta.url)),
      '@worker': fileURLToPath(new URL('./src/worker', import.meta.url)),
      '@shared': fileURLToPath(new URL('./src/shared', import.meta.url)),
    },
  },
});
