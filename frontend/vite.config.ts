import { sveltekit } from '@sveltejs/kit/vite';
import { defineConfig } from 'vite';
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
	'/reset': {
		target: API_PROXY_TARGET,
		changeOrigin: true,
		secure: false,
	},
	'/api': {
		target: API_PROXY_TARGET,
		changeOrigin: true,
		secure: false,
	},
	// RPC Proxy - Forward JSON-RPC to runtime server (/rpc endpoint)
	'/rpc': {
		target: API_PROXY_TARGET,
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

const PREVIEW_PROXY_PREFIXES = ['/api', '/rpc', '/reset'];

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
		sveltekit(),
		{
			name: 'xln-preview-http-proxy',
			configurePreviewServer(server) {
				server.middlewares.use(createPreviewHttpProxyMiddleware(API_PROXY_TARGET));
			},
		},
	],
	publicDir: 'static',
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
		define: {
		// Define globals for browser compatibility
		global: 'globalThis',
		__BUILD_NUMBER__: JSON.stringify(BUILD_NUMBER),
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
