import { sveltekit } from '@sveltejs/kit/vite';
import { defineConfig } from 'vite';

/**
 * HTTP-only vite config for port 8081
 * Use alongside main HTTPS server on 8080
 */

export default defineConfig({
	plugins: [sveltekit()],
	server: {
		host: '0.0.0.0',
		port: 8081,
		// NO HTTPS - plain HTTP only
		allowedHosts: ['all'],
		fs: {
			allow: ['..']
		},
		watch: {
			usePolling: false,
		},
		hmr: {
			overlay: false,
			protocol: 'ws',
			host: 'localhost',
			port: 8081,
			clientPort: 8081
		},
		// RPC Proxy - same as main config
		proxy: {
			'/rpc/arrakis': {
				target: 'http://localhost:8545',
				changeOrigin: true,
				rewrite: (path) => path.replace(/^\/rpc\/arrakis/, ''),
				ws: true,
			},
			'/rpc/wakanda': {
				target: 'http://localhost:8546',
				changeOrigin: true,
				rewrite: (path) => path.replace(/^\/rpc\/wakanda/, ''),
				ws: true,
			}
		},
		headers: {
			'Cache-Control': 'no-cache, no-store, must-revalidate',
			'Pragma': 'no-cache',
			'Expires': '0'
		}
	},
	esbuild: {
		target: 'es2022'
	},
	define: {
		global: 'globalThis',
	},
	resolve: {
		alias: {
			'$types': '../src/types.ts'
		}
	}
});
