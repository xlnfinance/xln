import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { fileURLToPath } from 'node:url';

export default defineConfig({
	plugins: [react()],
	server: {
		port: 5183,
		strictPort: true,
		fs: {
			// brainvault workers and runtime types live one level up.
			allow: ['..'],
		},
	},
	resolve: {
		alias: {
			'@': fileURLToPath(new URL('./src', import.meta.url)),
			// Types come from ../runtime source; runtime values load from /runtime.js at runtime.
			'@xln/core': fileURLToPath(new URL('../core', import.meta.url)),
		},
	},
	build: {
		target: 'es2022',
	},
});
