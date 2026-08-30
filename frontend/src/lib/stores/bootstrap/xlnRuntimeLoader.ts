import { writable } from 'svelte/store';
import type { XLNModule } from '@xln/core/api/public/runtime-module';
import { isXLNModuleLoaded } from '@xln/core/api/public/runtime-module-guard';
import { createBrowserRuntimeModuleLoader } from '../../../../packages/browser/src/runtime-module-loader';
import { registerDebugSurface } from '$lib/utils/runtime/debugSurface';
import '$lib/utils/runtime/wireDebug';

let XLN: XLNModule | null = null;

const runtimeLoader = createBrowserRuntimeModuleLoader<XLNModule>({
	validate: isXLNModuleLoaded,
	readSchemaVersion: runtime => (runtime as XLNModule & { RUNTIME_SCHEMA_VERSION?: number }).RUNTIME_SCHEMA_VERSION,
});

export const xlnInstance = writable<XLNModule | null>(null);
registerDebugSurface('instance', () => XLN);

export async function getXLN(): Promise<XLNModule> {
	if (XLN) return XLN;
	XLN = await runtimeLoader.load();
	xlnInstance.set(XLN);
	return XLN;
}
