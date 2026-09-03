import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { fileURLToPath } from 'node:url';

export default defineConfig({
	plugins: [react()],
	server: {
		port: 5183,
		strictPort: true,
		fs: {
			// brainvault workers, runtime types and shared frontend logic live one level up.
			allow: ['..'],
		},
	},
	preview: {
		port: 5184,
		strictPort: true,
	},
	resolve: {
		alias: {
			'@': fileURLToPath(new URL('./src', import.meta.url)),
			// Types come from ../core source; runtime values load from /runtime.js at runtime.
			'@xln/core': fileURLToPath(new URL('../core', import.meta.url)),
			// Framework-free wallet logic shared with the SvelteKit frontend: invoices,
			// route quoting, payment commands, swap math. One implementation, two shells.
			'@xln/frontend': fileURLToPath(new URL('../frontend/src', import.meta.url)),
			$lib: fileURLToPath(new URL('../frontend/src/lib', import.meta.url)),
		},
	},
	build: {
		target: 'es2022',
	},
});
