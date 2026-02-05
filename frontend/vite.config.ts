import { sveltekit } from '@sveltejs/kit/vite';
import { defineConfig } from 'vite';
import fs from 'fs';
import net from 'net';

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
let certPath = './localhost+3.pem';
let keyPath = './localhost+3-key.pem';
let hasCerts = fs.existsSync(certPath) && fs.existsSync(keyPath);

// Fallback to localhost+2 certs
if (!hasCerts) {
	certPath = './localhost+2.pem';
	keyPath = './localhost+2-key.pem';
	hasCerts = fs.existsSync(certPath) && fs.existsSync(keyPath);
}

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

const DEV_HOST = '0.0.0.0';
const DEV_PORT = 8080;

async function assertPortAvailable(port: number, host: string): Promise<void> {
	return new Promise((resolve, reject) => {
		const server = net.createServer();

		server.once('error', (err: NodeJS.ErrnoException) => {
			if (err.code === 'EADDRINUSE') {
				console.error(`\n❌ Port ${port} is already in use.`);
				console.error('Please stop the process that is using it, then retry.');
				console.error(`\nFind the process:\n  lsof -nP -iTCP:${port} -sTCP:LISTEN`);
				console.error(`Kill it (example):\n  lsof -ti TCP:${port} | xargs kill -9\n`);
				process.exit(1);
			}
			reject(err);
		});

		server.once('listening', () => {
			server.close(() => resolve());
		});

		server.listen(port, host);
	});
}

export default defineConfig(async ({ command }) => {
	if (command === 'serve') {
		await assertPortAvailable(DEV_PORT, DEV_HOST);
	}

	return {
	plugins: [sveltekit()],
	publicDir: 'static',
	server: {
		host: DEV_HOST,
		port: DEV_PORT,
		strictPort: true,
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
				port: DEV_PORT,
				clientPort: DEV_PORT
			})
		},
		// API Proxy - Forward to server.ts faucet endpoints
		proxy: {
			'/api': {
				target: 'http://localhost:8082',
				changeOrigin: true,
			},
			// RPC Proxy - Forward JSON-RPC to local anvil for dev
			'/rpc': {
				target: 'http://localhost:8545',
				changeOrigin: true,
			},
			// Relay Proxy - Forward WebSocket to relay server for P2P
			'/relay': {
				target: 'ws://localhost:9000',
				ws: true,
				changeOrigin: true,
			},
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
		// Build hash for stale version detection (changes on every build)
		__BUILD_HASH__: JSON.stringify(Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 8)),
		__BUILD_TIME__: JSON.stringify(new Date().toISOString()),
	},
	resolve: {
		alias: {
			// Direct import from source types - single source of truth
			'$types': '../src/types.ts'
		}
	}
	};
});
