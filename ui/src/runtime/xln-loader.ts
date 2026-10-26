import type { XLNModule } from '@xln/core/api/public/runtime-module';
import { isXLNModuleLoaded } from '@xln/core/api/public/runtime-module-guard';

let loaded: XLNModule | null = null;
let loadPromise: Promise<XLNModule> | null = null;

/** Synchronous access after getXLN() resolved; null before. */
export function peekXLN(): XLNModule | null {
	return loaded;
}

/**
 * The canonical browser runtime bundle for this page load. Values come from
 * /runtime.js (built by scripts/build-runtime.sh before every dev/build run);
 * types come from ../runtime source. Cache-busted per page load: a stale
 * runtime.js silently desyncs UI and runtime schemas.
 */
let runtimeUrl: string | null = null;
const resolveRuntimeUrl = (): string =>
	(runtimeUrl ??= new URL(`${import.meta.env.BASE_URL}runtime.js?v=${Date.now()}`, window.location.origin).href);

/**
 * Every wallet session boots this bundle, but getXLN() first runs after the
 * password is entered, so a multi-megabyte download and compile sat on the
 * unlock path. The page entry calls this while the Gate is shown; getXLN()
 * then imports the same URL from the module map.
 */
export function preloadXLN(): void {
	const link = document.createElement('link');
	link.rel = 'modulepreload';
	link.href = resolveRuntimeUrl();
	document.head.append(link);
}

/**
 * Evaluate the bundle before the caller needs it. A failure is reported here
 * and raised again by the next getXLN(), which retries with a fresh URL.
 */
export function warmXLN(): void {
	getXLN().catch(error => console.error('[xln-loader] runtime bundle failed to load', error));
}

export async function getXLN(): Promise<XLNModule> {
	if (loaded) return loaded;
	if (loadPromise) return loadPromise;

	loadPromise = (async () => {
		// The account transition must run the same way as every other runtime on the network
		// (worker pool); an inline-only shim here produced bilateral prev-hash mismatches against the hub.
		const module: unknown = await import(/* @vite-ignore */ resolveRuntimeUrl());
		if (!isXLNModuleLoaded(module)) {
			throw new Error('RUNTIME_API_MISMATCH: runtime.js is missing required bootstrap exports');
		}
		const schema = Number((module as { RUNTIME_SCHEMA_VERSION?: unknown }).RUNTIME_SCHEMA_VERSION ?? NaN);
		if (!Number.isFinite(schema) || schema < 1) {
			throw new Error(`RUNTIME_VERSION_MISMATCH: invalid runtime schema=${String(schema)}`);
		}
		loaded = module;
		return module;
	})();

	try {
		return await loadPromise;
	} catch (error) {
		// A module map may retain a failed fetch; a retry asks for a fresh URL.
		loadPromise = null;
		runtimeUrl = null;
		throw error;
	}
}
