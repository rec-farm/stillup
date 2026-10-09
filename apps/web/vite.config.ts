import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { docsHighlight } from './build/docs-highlight.ts';
import { docsPages } from './build/docs-pages.ts';

const target = process.env.API_URL ?? 'http://127.0.0.1:3001';
export default defineConfig({
  plugins: [react(), docsHighlight(), docsPages()],
  build: { manifest: true },
  server: {
    host: '127.0.0.1',
    port: 3000,
    strictPort: true,
    allowedHosts: ['stillup.localhost'],
    proxy: {
      '/api/v1': { target, changeOrigin: false, rewrite: (path) => path.replace(/^\/api/, '') },
      '/v1/probe': { target, changeOrigin: false },
    },
  },
});
