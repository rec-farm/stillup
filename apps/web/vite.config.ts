import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { docsHighlight } from './build/docs-highlight.ts';

const target = process.env.API_URL ?? 'http://127.0.0.1:3001';
export default defineConfig({
  plugins: [react(), docsHighlight()],
  build: { manifest: true },
  server: {
    host: '127.0.0.1',
    strictPort: true,
    allowedHosts: ['stillup.localhost'],
    proxy: {
      '/api/v1': { target, changeOrigin: false, rewrite: (path) => path.replace(/^\/api/, '') },
      '/v1/probe': { target, changeOrigin: false },
    },
  },
});
