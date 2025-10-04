import { sveltekit } from '@sveltejs/kit/vite';
import { defineConfig } from 'vite';

export default defineConfig({
	plugins: [sveltekit()],
	server: {
		host: '0.0.0.0',
		port: 8080,
		fs: {
			// Allow serving files from the parent directory (to access ../dist/)
			allow: ['..']
		},
		// Fast development setup
		watch: {
			usePolling: false,  // Use native file watching (faster)
		},
		hmr: {
			overlay: false
		},
		// Force no-cache headers for static files
		headers: {
			'Cache-Control': 'no-cache, no-store, must-revalidate',
			'Pragma': 'no-cache',
			'Expires': '0'
		}
	},
	// Fast builds
	esbuild: {
		target: 'es2022'
	},
	define: {
		// Define globals for browser compatibility
		global: 'globalThis',
	},
	resolve: {
		alias: {
			// BROWSER TARGET: Node.js modules not available in browser - remove aliases
		}
	}
});
