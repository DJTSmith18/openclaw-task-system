import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  base: '/dashboard/',
  server: {
    proxy: {
      '/dashboard/api': 'http://localhost:18790',
      '/dashboard/webhooks': 'http://localhost:18790',
    },
  },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
  },
});
