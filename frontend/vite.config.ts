import { sveltekit } from '@sveltejs/kit/vite';
import { defineConfig } from 'vite';
import fs from 'fs';

/**
 * HTTPS CONFIGURATION (DEV-ONLY)
 *
 * IMPORTANT: This HTTPS config is ONLY for `vite dev` (development server)
 *
 * Production deployment:
 * - `bun run build` generates static files → frontend/build/
 * - nginx serves static files with its OWN HTTPS config
 * - This vite.config.ts is NOT used in production
 *
 * Your nginx deployment is safe - it uses its own certificates!
 */

// Check if HTTPS certs exist (try multiple locations)
let certPath = './localhost+2.pem';
let keyPath = './localhost+2-key.pem';
let hasCerts = fs.existsSync(certPath) && fs.existsSync(keyPath);

// Fallback to LAN IP certs if localhost certs don't exist
if (!hasCerts) {
	certPath = '../192.168.1.23+2.pem';
	keyPath = '../192.168.1.23+2-key.pem';
	hasCerts = fs.existsSync(certPath) && fs.existsSync(keyPath);
}

if (!hasCerts) {
	console.warn('⚠️  HTTPS certs not found. Run: ./generate-certs.sh');
	console.warn('   (Optional - only needed for local HTTPS development)');
}

export default defineConfig({
	plugins: [sveltekit()],
	server: {
		host: '0.0.0.0',
		port: 8080,
		// HTTPS for dev server only (nginx handles production HTTPS)
		...(hasCerts && {
			https: {
				key: fs.readFileSync(keyPath),
				cert: fs.readFileSync(certPath),
			}
		}),
		// Allow ngrok and other tunnel hosts (for Oculus/mobile access)
		allowedHosts: ['all'],
		fs: {
			// Allow serving files from the parent directory (to access ../dist/)
			allow: ['..']
		},
		// Fast development setup
		watch: {
			usePolling: false,  // Use native file watching (faster)
		},
		hmr: {
			overlay: false,
			...(hasCerts && {
				protocol: 'wss',
				host: 'localhost',
				port: 8080,
				clientPort: 8080
			})
		},
		// RPC Proxy - DISABLED (using BrowserVM now)
		// proxy: {
		// 	'/rpc/arrakis': {
		// 		target: 'http://localhost:8545',
		// 		changeOrigin: true,
		// 		rewrite: (path) => path.replace(/^\/rpc\/arrakis/, ''),
		// 		ws: true,
		// 	},
		// },
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
			// Direct import from source types - single source of truth
			'$types': '../src/types.ts'
		}
	}
});
