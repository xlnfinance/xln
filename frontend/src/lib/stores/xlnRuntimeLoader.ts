import { createExternalStore } from '../../../packages/client-core/external-store';
import { toSvelteWritable } from './adapters/svelteExternalStore';
import type { XLNModule } from '@xln/runtime/api/public/runtime-module';
import { isXLNModuleLoaded } from '@xln/runtime/api/public/runtime-module-guard';
import { registerDebugSurface } from '$lib/utils/debugSurface';
import '$lib/utils/wireDebug';

let XLN: XLNModule | null = null;
let xlnLoadPromise: Promise<XLNModule> | null = null;

export interface XlnRuntimeLoaderPorts {
	runtimeUrl(): string;
	load(url: string): Promise<unknown>;
}

export const loadXlnRuntimeModule = async (
	ports: XlnRuntimeLoaderPorts,
): Promise<XLNModule> => {
	const loaded = await ports.load(ports.runtimeUrl());
	if (!isXLNModuleLoaded(loaded)) {
		throw new Error('RUNTIME_API_MISMATCH: runtime.js is missing required bootstrap exports');
	}
	const runtimeMeta = loaded as XLNModule & { RUNTIME_SCHEMA_VERSION?: number };
	const loadedSchema = Number(runtimeMeta.RUNTIME_SCHEMA_VERSION ?? NaN);
	if (!Number.isFinite(loadedSchema) || loadedSchema < 1) {
		throw new Error(
			`RUNTIME_VERSION_MISMATCH: invalid runtime schema=${String(runtimeMeta.RUNTIME_SCHEMA_VERSION ?? 'undefined')}`,
		);
	}
	return loaded;
};

const xlnInstanceBinding = createExternalStore<XLNModule | null>(null);
export const xlnInstanceExternalStore = xlnInstanceBinding.store;
export const xlnInstance = toSvelteWritable(xlnInstanceBinding);
registerDebugSurface('instance', () => XLN);

export async function getXLN(): Promise<XLNModule> {
	if (XLN) return XLN;
	if (xlnLoadPromise) return xlnLoadPromise;

	xlnLoadPromise = (async () => {
		const loaded = await loadXlnRuntimeModule({
			// Cache-bust once per page load; stale runtime.js caused prod-debug desync.
			runtimeUrl: () => new URL(`/runtime.js?v=${Date.now()}`, window.location.origin).href,
			load: (runtimeUrl) => import(/* @vite-ignore */ runtimeUrl),
		});
		XLN = loaded;
		xlnInstance.set(XLN);
		return XLN;
	})();

	try {
		return await xlnLoadPromise;
	} catch (err) {
		xlnLoadPromise = null;
		throw err;
	}
}
