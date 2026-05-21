import { writable } from 'svelte/store';
import type { XLNModule } from '@xln/runtime/xln-api';

let XLN: XLNModule | null = null;
let xlnLoadPromise: Promise<XLNModule> | null = null;

export const xlnInstance = writable<XLNModule | null>(null);

export async function getXLN(): Promise<XLNModule> {
	if (XLN) return XLN;
	if (xlnLoadPromise) return xlnLoadPromise;

	xlnLoadPromise = (async () => {
		// Cache-bust runtime module per page load; stale runtime.js caused prod-debug desync.
		const runtimeUrl = new URL(`/runtime.js?v=${Date.now()}`, window.location.origin).href;
		const loaded = (await import(/* @vite-ignore */ runtimeUrl)) as XLNModule;
		const runtimeMeta = loaded as XLNModule & { RUNTIME_SCHEMA_VERSION?: number };
		const loadedSchema = Number(runtimeMeta.RUNTIME_SCHEMA_VERSION ?? NaN);
		if (!Number.isFinite(loadedSchema) || loadedSchema < 1) {
			throw new Error(
				`RUNTIME_VERSION_MISMATCH: invalid runtime schema=${String(runtimeMeta.RUNTIME_SCHEMA_VERSION ?? 'undefined')}`,
			);
		}
		XLN = loaded;
		xlnInstance.set(XLN);
		if (typeof window !== 'undefined') {
			window.__xln_instance = XLN;
		}
		return XLN;
	})();

	try {
		return await xlnLoadPromise;
	} catch (err) {
		xlnLoadPromise = null;
		throw err;
	}
}
