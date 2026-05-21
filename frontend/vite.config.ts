import { sveltekit } from '@sveltejs/kit/vite';
import { defineConfig } from 'vite';
import type { Plugin, PreviewServer, ViteDevServer } from 'vite';
import fs from 'fs';
import net from 'net';
import http from 'node:http';
import https from 'node:https';
import { execSync } from 'node:child_process';
import { URL, fileURLToPath } from 'node:url';

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
const DEV_PORT_RAW = Number(process.env['VITE_DEV_PORT'] || '8080');
const DEV_PORT = Number.isFinite(DEV_PORT_RAW) && DEV_PORT_RAW > 0 ? Math.floor(DEV_PORT_RAW) : 8080;
const API_PROXY_TARGET = process.env['VITE_API_PROXY_TARGET'] || 'http://localhost:8082';
const VITE_CACHE_DIR = process.env['VITE_CACHE_DIR'] || 'node_modules/.vite';
const REPO_ROOT = fileURLToPath(new URL('..', import.meta.url));
const TYPECHAIN_INDEX = fileURLToPath(new URL('../jurisdictions/typechain-types/index.ts', import.meta.url));
const RUNTIME_BUNDLE_PATH = fileURLToPath(new URL('./static/runtime.js', import.meta.url));
const BUILD_NUMBER = (() => {
  const explicit = String(process.env['XLN_BUILD_NUMBER'] || '').trim();
  if (explicit) return explicit;
  try {
    return execSync('git rev-list --count HEAD', {
      cwd: REPO_ROOT,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim() || '0';
  } catch {
    return '0';
  }
})();
const ENABLE_HMR = (() => {
  const value = String(process.env['VITE_ENABLE_HMR'] || '').toLowerCase();
  return value === '1' || value === 'true' || value === 'yes';
})();
const hmrConfig = ENABLE_HMR ? {
	overlay: false,
	...(hasCerts && {
		protocol: 'wss',
		host: 'localhost',
		port: DEV_PORT,
		clientPort: DEV_PORT
	})
} : false;

const proxyConfig = {
	'/api': {
		target: API_PROXY_TARGET,
		changeOrigin: true,
		secure: false,
	},
	// RPC Proxy - Forward JSON-RPC to runtime server (/rpc endpoint)
	'/rpc': {
		target: API_PROXY_TARGET,
		ws: true,
		changeOrigin: true,
		secure: false,
	},
	'/rpc2': {
		target: API_PROXY_TARGET,
		ws: true,
		changeOrigin: true,
		secure: false,
	},
	// Relay Proxy - Forward WebSocket to relay server for P2P
	'/relay': {
		target: API_PROXY_TARGET,
		ws: true,
		changeOrigin: true,
	},
};

const PREVIEW_PROXY_PREFIXES = ['/api', '/rpc'];

function createPreviewHttpProxyMiddleware(targetBase: string) {
	const upstream = new URL(targetBase);
	const transport = upstream.protocol === 'https:' ? https : http;

	return (req: http.IncomingMessage, res: http.ServerResponse, next: (err?: unknown) => void) => {
		const requestUrl = String(req.url || '');
		if (!PREVIEW_PROXY_PREFIXES.some((prefix) => requestUrl === prefix || requestUrl.startsWith(`${prefix}/`))) {
			next();
			return;
		}

		const targetUrl = new URL(requestUrl, upstream);
		const proxyReq = transport.request(targetUrl, {
			method: req.method,
			headers: {
				...req.headers,
				host: upstream.host,
			},
		}, (proxyRes) => {
			res.writeHead(proxyRes.statusCode || 502, proxyRes.headers);
			proxyRes.pipe(res);
		});

		proxyReq.on('error', (error) => {
			if (res.headersSent) {
				res.end();
				return;
			}
			res.statusCode = 502;
			res.setHeader('content-type', 'application/json');
			res.end(JSON.stringify({
				error: 'PREVIEW_PROXY_FAILED',
				details: error instanceof Error ? error.message : String(error),
			}));
		});

		req.pipe(proxyReq);
	};
}

function createRuntimeBundleMiddleware() {
	return (req: http.IncomingMessage, res: http.ServerResponse, next: (err?: unknown) => void) => {
		const requestPath = String(req.url || '').split('?')[0];
		if (requestPath !== '/runtime.js') {
			next();
			return;
		}

		if (!fs.existsSync(RUNTIME_BUNDLE_PATH)) {
			res.statusCode = 503;
			res.setHeader('content-type', 'application/json');
			res.end(JSON.stringify({ error: 'RUNTIME_BUNDLE_MISSING' }));
			return;
		}

		res.statusCode = 200;
		res.setHeader('content-type', 'text/javascript; charset=utf-8');
		res.setHeader('cache-control', 'no-store, must-revalidate');
		fs.createReadStream(RUNTIME_BUNDLE_PATH).pipe(res);
	};
}

function runtimeBundlePlugin(): Plugin {
	return {
		name: 'xln-runtime-bundle',
		enforce: 'pre',
		configureServer(server: ViteDevServer) {
			server.middlewares.use(createRuntimeBundleMiddleware());
		},
		configurePreviewServer(server: PreviewServer) {
			server.middlewares.use(createRuntimeBundleMiddleware());
		},
	};
}

function manualClientChunk(id: string): string | undefined {
	if (!id.includes('/node_modules/')) return undefined;
	if (
		id.includes('/node_modules/svelte/') ||
		id.includes('/node_modules/svelte-') ||
		id.includes('/node_modules/@sveltejs/') ||
		id.includes('/node_modules/esm-env/')
	) {
		return 'vendor-svelte';
	}
	if (id.includes('/node_modules/three/')) {
		return 'vendor-three';
	}
	if (id.includes('/node_modules/lucide-svelte/')) {
		return 'vendor-icons';
	}
	if (id.includes('/node_modules/@capacitor/')) {
		return 'vendor-capacitor';
	}
	if (id.includes('/node_modules/@ethereumjs/') || id.includes('/node_modules/ethers/')) {
		return 'vendor-chain';
	}
	if (
		id.includes('/node_modules/@noble/') ||
		id.includes('/node_modules/@node-rs/argon2/') ||
		id.includes('/node_modules/argon2/') ||
		id.includes('/node_modules/bip39/') ||
		id.includes('/node_modules/crypto-js/') ||
		id.includes('/node_modules/hash-wasm/')
	) {
		return 'vendor-crypto';
	}
	if (id.includes('/node_modules/dockview/')) {
		return 'vendor-dockview';
	}
	if (
		id.includes('/node_modules/jdenticon/') ||
		id.includes('/node_modules/marked/') ||
		id.includes('/node_modules/jsqr/') ||
		id.includes('/node_modules/qrcode/') ||
		id.includes('/node_modules/msgpackr/')
	) {
		return 'vendor-ui-utils';
	}
	return 'vendor';
}

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
	plugins: [
		runtimeBundlePlugin(),
		sveltekit(),
		{
			name: 'xln-preview-http-proxy',
				configurePreviewServer(server: PreviewServer) {
					server.middlewares.use(createPreviewHttpProxyMiddleware(API_PROXY_TARGET));
				},
		},
	],
	cacheDir: VITE_CACHE_DIR,
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
		hmr: hmrConfig,
		// API/Relay proxy
		proxy: proxyConfig,
		// Force no-cache headers for static files
		headers: {
			'Cache-Control': 'no-cache, no-store, must-revalidate',
			'Pragma': 'no-cache',
			'Expires': '0'
		}
	},
	preview: {
		host: DEV_HOST,
		port: DEV_PORT,
		strictPort: true,
		...(hasCerts && {
			https: {
				key: fs.readFileSync(keyPath),
				cert: fs.readFileSync(certPath),
			}
		}),
		proxy: proxyConfig,
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
	build: {
		// The app intentionally ships runtime/3D workspaces. Keep warnings focused
		// on accidental multi-megabyte chunks after the explicit vendor split above.
		chunkSizeWarningLimit: 1500,
		rollupOptions: {
			output: {
				manualChunks: manualClientChunk,
			},
		},
	},
		define: {
		// Define globals for browser compatibility
		global: 'globalThis',
		__BUILD_NUMBER__: JSON.stringify(BUILD_NUMBER),
		__BUILD_TIME__: JSON.stringify(new Date().toISOString()),
	},
	resolve: {
		alias: {
			// Direct import from source types - single source of truth
			'$types': '../src/types.ts',
			// Runtime files are imported from multiple depths during SSR bundling.
			// Keep TypeChain resolution anchored to the repo root instead of
			// relying on fragile relative traversal from the importer path.
			'../jurisdictions/typechain-types/index.ts': TYPECHAIN_INDEX,
			'../../jurisdictions/typechain-types/index.ts': TYPECHAIN_INDEX,
		}
	}
	};
});
