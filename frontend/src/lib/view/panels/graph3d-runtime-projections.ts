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

  // Historical: the selected step's frames are the whole truth. Iterating them (rather than
  // the connected-runtime map) is also what lets a recorded scenario render — it is a
  // network with no live runtime behind it.
  if (networkStep) {
    for (const [runtimeId, frame] of input.networkState.frames) {
      const runtime = input.runtimeMap.get(runtimeId);
      projections.push(projectRuntimeGraphFrame(frame, {
        runtimeId,
        label: runtime?.label || runtimeId,
        adapterKind: runtime?.type === 'remote' ? 'remote' : 'browser',
      }));
    }
    return projections;
  }

  for (const runtime of input.runtimeMap.values()) {
    const runtimeId = String(runtime.id || '')
      .trim()
      .toLowerCase();

    // Live: local runtimes project their in-memory env, remote ones their cached frame.
    if (runtime.type === 'local') {
      const selected = runtimeId === activeId && input.currentEnv
        ? input.currentEnv
        : runtime.env;
      if (selected) {
        projections.push(projectRuntimeEnv(selected, { runtimeId, label: runtime.label, adapterKind: 'browser' }));
      }
      continue;
    }
    const frame = input.liveRemoteFrames.get(runtimeId) ?? null;
    if (frame) {
      projections.push(projectRuntimeGraphFrame(frame, { runtimeId, label: runtime.label, adapterKind: 'remote' }));
    }
  }
  const envRuntimeId = String(input.currentEnv?.runtimeId || activeId || 'browser')
    .trim()
    .toLowerCase();
  if (
    input.currentEnv &&
    !projections.some(projection => projection.source.runtimeId === envRuntimeId)
  ) {
    projections.push(
      projectRuntimeEnv(input.currentEnv, { runtimeId: envRuntimeId, label: 'Browser', adapterKind: 'browser' }),
    );
  }
  return projections;
}
