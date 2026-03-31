import { sveltekit } from '@sveltejs/kit/vite';
import { defineConfig } from 'vite';
import { execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = fileURLToPath(new URL('..', import.meta.url));
const BUILD_NUMBER = (() => {
	const explicit = String(process.env['XLN_BUILD_NUMBER'] || '').trim();
	if (explicit) return explicit;
	try {
		return execSync('git rev-list --count HEAD', {
			cwd: REPO_ROOT,
			encoding: 'utf8',
			stdio: ['ignore', 'pipe', 'ignore']
		}).trim() || '0';
	} catch {
		return '0';
	}
})();

const ENABLE_HMR = (() => {
	const value = String(process.env['VITE_ENABLE_HMR'] || '').toLowerCase();
	return value === '1' || value === 'true' || value === 'yes';
})();

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
		hmr: ENABLE_HMR
			? {
				overlay: false,
				protocol: 'ws',
				host: 'localhost',
				port: 8081,
				clientPort: 8081
			}
			: false,
		// RPC Proxy - same single-path design as main config
		proxy: {
			'/rpc': {
				target: process.env['VITE_API_PROXY_TARGET'] || 'http://localhost:8082',
				changeOrigin: true,
				secure: false,
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
		__BUILD_NUMBER__: JSON.stringify(BUILD_NUMBER),
	},
	resolve: {
		alias: {
			'$types': '../src/types.ts'
		}
	}
});
