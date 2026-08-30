import type { RuntimeAdapter, XLNModule } from '../../../../core/api/public/runtime-module';
import { isXLNModuleLoaded } from '../../../../core/api/public/runtime-module-guard';
import { createBrowserRuntimeModuleLoader } from '../../../packages/browser/src/runtime-module-loader';
import type { WalletEmbeddedRuntimeResource } from '../../../packages/browser/src/wallet-embedded-runtime-session';
import { bootEmbeddedRuntimeAdapter } from './wallet-embedded-runtime-adapter';

const runtimeLoader = createBrowserRuntimeModuleLoader<XLNModule>({
  validate: isXLNModuleLoaded,
  readSchemaVersion: runtime => runtime.RUNTIME_SCHEMA_VERSION,
});

export const bootWalletEmbeddedRuntime = async (
  setPageUnloadFence: (fence: () => void) => void,
): Promise<WalletEmbeddedRuntimeResource<RuntimeAdapter>> =>
  bootEmbeddedRuntimeAdapter(await runtimeLoader.load(), setPageUnloadFence);
