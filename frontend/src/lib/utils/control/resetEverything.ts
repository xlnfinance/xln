import {
  resetBrowserRuntimeData,
  type ResetEverythingRequest,
} from '../../../../packages/browser/src/browser-runtime-reset';
import { publishBrowserHardResetRequest } from '../../../../packages/browser/src/hard-reset-request';
import { shutdownRuntimeResumeListener, vaultOperations } from '../../stores/vault/vaultStore';

export type { ResetEverythingRequest } from '../../../../packages/browser/src/browser-runtime-reset';

async function stopCurrentRuntimeActivity(): Promise<void> {
  await vaultOperations.suspendAllRuntimeActivity?.();
  shutdownRuntimeResumeListener?.();
}

export { clearBrowserRuntimeData } from '../../../../packages/browser/src/browser-runtime-reset';

export async function resetEverything(request: ResetEverythingRequest): Promise<void> {
  await resetBrowserRuntimeData(request, {
    beforeClear: async () => {
      await stopCurrentRuntimeActivity();
      publishBrowserHardResetRequest();
    },
  });
}
