import { defineConfig, type Plugin, type ViteDevServer } from 'vite';
import react from '@vitejs/plugin-react';
import { createReadStream, existsSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

/** Bundles the wallet loads at runtime: the core API and the account worker. */
const RUNTIME_BUNDLES = new Set(['/runtime.js', '/account-worker.js']);
const RUNTIME_BUNDLE_WAIT_MS = 90_000;

/**
 * Inside `bun run dev` the repo's runtime role rebuilds one bundle pair into
 * frontend/static on every core edit. Serve that pair here instead of a second
 * copy so the wallet and observer always run the same core; a request that arrives while
 * the first build is still running waits for the file rather than failing.
 */
function sharedRuntimeBundle(dir: string, base: string): Plugin {
	const install = (server: Pick<ViteDevServer, 'middlewares'>): void => {
			server.middlewares.use((req, res, next) => {
				const requestPath = new URL(req.url ?? '/', 'http://localhost').pathname;
				const pathname = base !== '/' && requestPath.startsWith(base) ? '/' + requestPath.slice(base.length) : requestPath;
				if (!RUNTIME_BUNDLES.has(pathname)) return next();
				const file = join(dir, pathname.slice(1));
				const deadline = Date.now() + RUNTIME_BUNDLE_WAIT_MS;
				const serve = (): void => {
					if (existsSync(file)) {
						res.setHeader('Content-Type', 'application/javascript; charset=utf-8');
						res.setHeader('Cache-Control', 'no-store');
						createReadStream(file).pipe(res);
						return;
					}
					if (Date.now() > deadline) {
						res.statusCode = 503;
						res.end(`RUNTIME_BUNDLE_NOT_BUILT:${file}`);
						return;
					}
					setTimeout(serve, 250);
				};
				serve();
			});
	};
	return {
		name: 'xln-shared-runtime-bundle',
		configureServer: install,
		configurePreviewServer: install,
	};
}

const sharedBundleDir = process.env['XLN_UI_RUNTIME_BUNDLE_DIR'];

/** Path prefix the hosted build lives under (xln.finance/ui/). The dev gateway sets the same prefix; standalone test stands may set their own base. */
const base = process.env['XLN_UI_BASE'] ?? '/';
/**
 * Dev only: the stack this dev server resolves to, exactly like frontend/vite.config.ts.
 * `bun run dev` exports API_PORT (the local orchestrator); XLN_UI_STACK_ORIGIN overrides it
 * (e.g. https://xln.finance). Without either the page has no API and the Gate offers the sandbox only.
 */
const stackOrigin = process.env['XLN_UI_STACK_ORIGIN'] ?? (process.env['API_PORT'] ? `http://127.0.0.1:${process.env['API_PORT']}` : '');

export default defineConfig(({ mode }) => ({
	...(mode === 'ios' ? { root: fileURLToPath(new URL('./native', import.meta.url)), publicDir: '../public' } : {}),
	base,
	// A TLS stack (xln.finance) cannot be WebSocket-proxied by this dev server; the wallet dials its relay directly.
	// The wallet compiles ../core from source, so the browser process shim in
	// core/support/process/runtime-process.ts needs the same build-time NODE_ENV
	// that scripts/build-runtime.sh injects into the prebuilt runtime bundle the
	// SvelteKit wallet loads. Without it the shim has no value to carry and the
	// page boots with dev semantics.
	define: {
		__XLN_UI_DIAGNOSTICS__: JSON.stringify(process.env['XLN_UI_DIAGNOSTICS'] === '1'),
		__XLN_STACK_ORIGIN__: JSON.stringify(stackOrigin),
		'process.env.NODE_ENV': JSON.stringify(process.env['NODE_ENV'] ?? 'development'),
	},
	plugins: [react(), ...(sharedBundleDir ? [sharedRuntimeBundle(sharedBundleDir, base)] : [])],
	server: {
		port: 5183,
		strictPort: true,
		// Packaged iOS code has a stable custom origin. Keep Vite's loopback origins
		// and permit this origin's preflight before the existing API/RPC proxy.
		cors: { origin: [/^https?:\/\/(?:(?:[^:]+\.)?localhost|127\.0\.0\.1|\[::1\])(?::\d+)?$/, 'xln://localhost'] },
		...(stackOrigin
			? {
					proxy: {
						'/api': { target: stackOrigin, changeOrigin: true, secure: false },
						'/rpc': { target: stackOrigin, changeOrigin: true, secure: false },
						// The relay derives its hello audience from the request Host; keep the browser's own.
						'/relay': { target: stackOrigin, ws: true, changeOrigin: false, secure: false },
						'/ws': { target: stackOrigin, ws: true, changeOrigin: false, secure: false },
					},
				}
			: {}),
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
			// Browser LevelDB needs EventEmitter; resolve the declared wallet dependency,
			// including when the importing core source lives above ui/node_modules.
			events: fileURLToPath(new URL('./node_modules/events/events.js', import.meta.url)),
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
		...(process.env['XLN_UI_BUILD_DIR'] ? { outDir: process.env['XLN_UI_BUILD_DIR'] } : {}),
		target: 'es2022',
		...(mode === 'ios' ? { outDir: '../native-dist', emptyOutDir: true } : {}),
	},
}));
