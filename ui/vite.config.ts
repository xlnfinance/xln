import { defineConfig, type Plugin } from 'vite';
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
 * copy so both wallets always run the same core; a request that arrives while
 * the first build is still running waits for the file rather than failing.
 */
function sharedRuntimeBundle(dir: string): Plugin {
	return {
		name: 'xln-shared-runtime-bundle',
		configureServer(server) {
			server.middlewares.use((req, res, next) => {
				const pathname = new URL(req.url ?? '/', 'http://localhost').pathname;
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
		},
	};
}

const sharedBundleDir = process.env['XLN_UI_RUNTIME_BUNDLE_DIR'];

export default defineConfig({
	plugins: [react(), ...(sharedBundleDir ? [sharedRuntimeBundle(sharedBundleDir)] : [])],
	server: {
		port: 5183,
		strictPort: true,
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
		target: 'es2022',
	},
});
