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
		// One wallet, a handful of accounts: the inline account transition is the
		// canonical path and boots faster than a pool of module workers. The pool's
		// URL is also root-absolute inside the runtime bundle, which breaks under a
		// path prefix such as /ui/ (docs/audit/2026-09-04-wallet-ui-core-findings.md #13).
		const processShim = (globalThis as { process?: { env?: Record<string, string | undefined> } }).process ?? {};
		processShim.env = { ...(processShim.env ?? {}), XLN_TS_ACCOUNT_WORKERS: '0' };
		(globalThis as { process?: unknown }).process = processShim;
		const url = new URL(`${import.meta.env.BASE_URL}runtime.js?v=${Date.now()}`, window.location.origin).href;
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
