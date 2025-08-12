import { defineConfig } from 'vite';
import { svelte } from '@sveltejs/vite-plugin-svelte';
import sveltePreprocess from 'svelte-preprocess';

export default defineConfig({
  base: './',
  plugins: [svelte({ preprocess: sveltePreprocess({ typescript: true, postcss: true }) })],
  server: {
    port: 5173,
    host: true,
    open: false,
    proxy: {
      '/dist': { target: 'http://localhost:8080', changeOrigin: true },
      '/ui': { target: 'http://localhost:8080', changeOrigin: true },
      '/jurisdictions.json': { target: 'http://localhost:8080', changeOrigin: true }
    }
  },
  build: {
    outDir: 'dist',
    sourcemap: false,
    target: 'es2022',
    rollupOptions: {
      external: ['/dist/server.js']
    }
  }
});


