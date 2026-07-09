import { derived, get, writable } from 'svelte/store';
import type { Env } from '@xln/runtime/xln-api';
import { activeRuntimeId, runtimes } from './runtimeStore';
import { createDetachedRuntimeViewEnv, createRuntimeViewEnv, unwrapLiveRuntimeEnv } from '$lib/utils/liveRuntimeEnv';
import { registerDebugSurface } from '$lib/utils/debugSurface';
import { errorLog } from './errorLogStore';

const bootstrapEnvironment = writable<Env | null>(null);

// Active env is derived from selected runtime in dropdown. A selected remote
// runtime intentionally has no Env; remote UI reads RuntimeView projections.
export const xlnEnvironment = derived(
  [bootstrapEnvironment, runtimes, activeRuntimeId],
  ([$bootstrapEnvironment, $runtimes, $activeRuntimeId]) => {
    const selectedRuntimeId = String($activeRuntimeId || '').toLowerCase();
    if (selectedRuntimeId) {
      const runtimeEntry = $runtimes.get(selectedRuntimeId);
      return runtimeEntry?.env ?? null;
    }
    return $bootstrapEnvironment;
  },
);

let localDebugEnv: Env | null = null;
registerDebugSurface('env', () => localDebugEnv);

export function setXlnEnvironment(env: Env | null): void {
  const runtimeEnv = unwrapLiveRuntimeEnv(env) ?? env;
  if (!runtimeEnv) {
    bootstrapEnvironment.set(null);
    localDebugEnv = null;
    return;
  }

  const viewEnv = createRuntimeViewEnv(runtimeEnv);
  const selectedRuntimeId = String(get(activeRuntimeId) || '').toLowerCase();
  const envRuntimeId = String(runtimeEnv.runtimeId || '').toLowerCase();
  const canPublishActiveEnv = !selectedRuntimeId || (envRuntimeId !== '' && envRuntimeId === selectedRuntimeId);

  if (canPublishActiveEnv) {
    bootstrapEnvironment.set(viewEnv);
    localDebugEnv = createDetachedRuntimeViewEnv(runtimeEnv);
  } else {
    const message = `RUNTIME_STORE_ENV_OVERWRITE_REFUSED: refusing to publish env ${envRuntimeId || '<missing>'} while runtime ${selectedRuntimeId} is selected`;
    errorLog.log(message, 'Runtime Env', { envRuntimeId: envRuntimeId || null, selectedRuntimeId });
    throw new Error(message);
  }

  const targetRuntimeId = envRuntimeId || (canPublishActiveEnv ? selectedRuntimeId : '');
  if (!targetRuntimeId) return;

  runtimes.update((map) => {
    const runtimeEntry = map.get(targetRuntimeId);
    if (!runtimeEntry) return map;
    const updated = new Map(map);
    updated.set(targetRuntimeId, {
      ...runtimeEntry,
      env: viewEnv,
      lastSynced: Date.now(),
    });
    return updated;
  });
}
