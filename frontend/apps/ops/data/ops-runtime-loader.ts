import { isXLNModuleLoaded } from '@xln/runtime/api/public/runtime-module-guard';
import type { XLNModule } from '@xln/runtime/api/public/runtime-module';

let modulePromise: Promise<XLNModule> | null = null;

export const loadOpsRuntime = async (): Promise<XLNModule> => {
  if (modulePromise) return modulePromise;
  modulePromise = import(/* @vite-ignore */ new URL('/runtime.js?surface=ops', window.location.origin).href).then((loaded: unknown) => {
    if (!isXLNModuleLoaded(loaded)) throw new Error('OPS_RUNTIME_API_MISMATCH');
    const schema = Number((loaded as { RUNTIME_SCHEMA_VERSION?: unknown }).RUNTIME_SCHEMA_VERSION);
    if (!Number.isFinite(schema) || schema < 1) throw new Error(`OPS_RUNTIME_SCHEMA_INVALID:${String(schema)}`);
    return loaded;
  }).catch((error: unknown) => { modulePromise = null; throw error; });
  return modulePromise;
};
