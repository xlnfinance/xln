import type { XLNModule } from '@xln/core/api/public/runtime-module';
import { isXLNModuleLoaded } from '@xln/core/api/public/runtime-module-guard';

let loaded: XLNModule | null = null;
let loadPromise: Promise<XLNModule> | null = null;

/** Synchronous access after getXLN() resolved; null before. */
export function peekXLN(): XLNModule | null {
	return loaded;
}

/**
 * Load the canonical browser runtime bundle.
 *
 * Values come from /runtime.js (built by scripts/build-runtime.sh before every
 * dev/build run); types come from ../runtime source. Cache-busted per page
 * load: a stale runtime.js silently desyncs UI and runtime schemas.
 */
export async function getXLN(): Promise<XLNModule> {
	if (loaded) return loaded;
	if (loadPromise) return loadPromise;

	loadPromise = (async () => {
		const url = new URL(`/runtime.js?v=${Date.now()}`, window.location.origin).href;
		const module: unknown = await import(/* @vite-ignore */ url);
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
		loadPromise = null;
		throw error;
	}
}
