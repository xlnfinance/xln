import type { RuntimeAdapterGraphFrame } from '@xln/runtime/api/runtime-module';
import { unwrapLiveRuntimeEnv } from '$lib/utils/liveRuntimeEnv';
import type { Runtime } from '$lib/stores/runtimeStore';
import type { NetworkMachineRuntimeState } from '$lib/stores/networkMachineRuntimeStore';
import {
  projectRuntimeEnv,
  projectRuntimeGraphFrame,
  type RuntimeGraphProjection,
} from '$lib/network3d/runtimeGraphProjection';

export type RuntimeGraphProjectionInputs = {
  runtimeMap: Map<string, Runtime>;
  activeRuntimeId: string;
  controllerRuntimeId: string;
  scope: string;
  networkState: NetworkMachineRuntimeState;
  liveRemoteFrames: Map<string, RuntimeAdapterGraphFrame>;
  currentEnv: any;
};

/** Projects every runtime source before canonicity selection merges duplicate entities. */
export function buildRuntimeGraphProjections(input: RuntimeGraphProjectionInputs): RuntimeGraphProjection[] {
  const projections: RuntimeGraphProjection[] = [];
  const activeId = String(input.activeRuntimeId || input.controllerRuntimeId || '')
    .trim()
    .toLowerCase();
  const networkStep = input.scope === 'merged' ? input.networkState.selectedStep : null;
  for (const runtime of input.runtimeMap.values()) {
    const runtimeId = String(runtime.id || '')
      .trim()
      .toLowerCase();
    if (runtime.type === 'local') {
      const selected = networkStep
        ? input.networkState.browserFrames.get(runtimeId)
        : runtimeId === activeId && input.currentEnv
          ? input.currentEnv
          : (unwrapLiveRuntimeEnv(runtime.env) ?? runtime.env);
      if (selected) {
        projections.push(projectRuntimeEnv(selected, { runtimeId, label: runtime.label, adapterKind: 'browser' }));
      }
      continue;
    }
    const frame = networkStep
      ? (input.networkState.remoteFrames.get(runtimeId) ?? null)
      : (input.liveRemoteFrames.get(runtimeId) ?? null);
    if (frame) {
      projections.push(projectRuntimeGraphFrame(frame, { runtimeId, label: runtime.label, adapterKind: 'remote' }));
    }
  }
  const envRuntimeId = String(input.currentEnv?.runtimeId || activeId || 'browser')
    .trim()
    .toLowerCase();
  if (
    !networkStep &&
    input.currentEnv &&
    !projections.some(projection => projection.source.runtimeId === envRuntimeId)
  ) {
    projections.push(
      projectRuntimeEnv(input.currentEnv, { runtimeId: envRuntimeId, label: 'Browser', adapterKind: 'browser' }),
    );
  }
  return projections;
}
