import { sveltekit } from '@sveltejs/kit/vite';
import { defineConfig } from 'vite';

export default defineConfig({
  plugins: [sveltekit()],
  server: {
    host: '127.0.0.1',
    port: 5173,
    fs: {
      // Allow serving files from the parent directory (to access ../dist/)
      allow: ['..'],
    },
  },
});
