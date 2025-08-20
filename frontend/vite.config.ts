import { sveltekit } from '@sveltejs/kit/vite';
import { defineConfig } from 'vite';
import path from 'path';

export default defineConfig({
	plugins: [sveltekit()],
	server: {
		host: '127.0.0.1',
		port: 5173,
		fs: {
			// Allow serving files from the parent directory (to access ../dist/)
			allow: ['..']
		}
	},
	resolve: {
		alias: {
			// Create alias for server modules
			'@server': path.resolve(__dirname, '../src'),
		}
	},
	define: {
		// Define globals for browser compatibility
		global: 'globalThis',
	},
	optimizeDeps: {
		// Include server dependencies for browser bundling
		include: ['level', 'ethers']
	}
});
