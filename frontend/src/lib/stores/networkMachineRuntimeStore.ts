import { get, writable } from 'svelte/store';
import type { RuntimeActivityEvent, RuntimeAdapterGraphFrame } from '@xln/runtime/xln-api';
import { compileNetworkMachine, type NetworkMachine, type NetworkMachineStep } from '$lib/network3d/networkMachine';
import {
  disconnectNetworkTimelineReaders,
  loadNetworkTimelineIndexes,
  readNetworkRuntimeActivity,
  readNetworkRuntimeFrame,
} from '$lib/network3d/networkTimelineLoader';
import { networkMachineConfig } from './networkMachineStore';
import { runtimes } from './runtimeStore';
import type { RuntimeTimelineIndex } from '$lib/network3d/runtimeGraphTimeline';

export type NetworkMachineRuntimeState = {
  loading: boolean;
  error: string | null;
  indexes: RuntimeTimelineIndex[];
  machine: NetworkMachine | null;
  selectedStepIndex: number;
  selectedStep: NetworkMachineStep | null;
  /** Graph frame per runtime at the selected step. Local and remote read the same shape. */
  frames: Map<string, RuntimeAdapterGraphFrame>;
  /** Activity events of the selected step, ordered — the caption source. */
  activity: RuntimeActivityEvent[];
};

const emptyState = (): NetworkMachineRuntimeState => ({
  loading: false,
  error: null,
  indexes: [],
  machine: null,
  selectedStepIndex: -1,
  selectedStep: null,
  frames: new Map(),
  activity: [],
});

const message = (error: unknown): string => error instanceof Error ? error.message : String(error || 'NetworkMachine failed');

export const networkMachineRuntime = writable<NetworkMachineRuntimeState>(emptyState());

export const assertNetworkMachineIsLive = (
  state: Pick<NetworkMachineRuntimeState, 'selectedStep'>,
): void => {
  if (!state.selectedStep) return;
  const event = state.selectedStep.event;
  throw new Error(`RUNTIME_COMMAND_REQUIRES_LIVE_VIEW: network-machine=${event.runtimeId}:h${event.height}`);
};

const compileCurrent = (indexes: RuntimeTimelineIndex[]): NetworkMachine =>
  compileNetworkMachine(indexes, get(networkMachineConfig));

let refreshRequestId = 0;
let selectionRequestId = 0;

export const networkMachineRuntimeOperations = {
  async refresh(): Promise<NetworkMachine> {
    const requestId = ++refreshRequestId;
    networkMachineRuntime.update((state) => ({ ...state, loading: true, error: null }));
    try {
      const indexes = await loadNetworkTimelineIndexes(get(runtimes));
      const machine = compileCurrent(indexes);
      if (requestId !== refreshRequestId) return machine;
      networkMachineRuntime.set({ ...emptyState(), indexes, machine });
      return machine;
    } catch (error) {
      if (requestId === refreshRequestId) networkMachineRuntime.update((state) => ({ ...state, loading: false, error: message(error) }));
      throw error;
    }
  },

  async selectStep(index: number): Promise<NetworkMachineStep> {
    const requestId = ++selectionRequestId;
    const current = get(networkMachineRuntime);
    const machine = compileCurrent(current.indexes);
    const safeIndex = Math.floor(Number(index));
    const step = machine.steps[safeIndex];
    if (!step) throw new Error(`NETWORK_MACHINE_STEP_INVALID:${index}`);
    networkMachineRuntime.update((state) => ({ ...state, loading: true, error: null, machine }));
    try {
      const runtimeMap = get(runtimes);
      const frames = new Map<string, RuntimeAdapterGraphFrame>();
      const activity: RuntimeActivityEvent[] = [];
      for (const [id, selected] of step.selection.byRuntime) {
        if (!selected) continue;
        const runtime = runtimeMap.get(id);
        if (!runtime) throw new Error(`NETWORK_MACHINE_RUNTIME_MISSING:${id}`);
        frames.set(id, await readNetworkRuntimeFrame(runtime, selected.height));
        if (id !== step.activeRuntimeId) continue;
        activity.push(...await readNetworkRuntimeActivity(runtime, selected.height, selected.height));
      }
      if (requestId !== selectionRequestId) return step;
      networkMachineRuntime.set({
        loading: false,
        error: null,
        indexes: current.indexes,
        machine,
        selectedStepIndex: safeIndex,
        selectedStep: step,
        frames,
        activity,
      });
      return step;
    } catch (error) {
      if (requestId === selectionRequestId) networkMachineRuntime.update((state) => ({ ...state, loading: false, error: message(error) }));
      throw error;
    }
  },

  goLive(): void {
    selectionRequestId += 1;
    networkMachineRuntime.update((state) => ({
      ...state,
      selectedStepIndex: -1,
      selectedStep: null,
      frames: new Map(),
      activity: [],
      error: null,
    }));
  },

  recompile(): NetworkMachine {
    const current = get(networkMachineRuntime);
    const machine = compileCurrent(current.indexes);
    networkMachineRuntime.update((state) => ({ ...state, machine }));
    return machine;
  },

  dispose(): void {
    refreshRequestId += 1;
    selectionRequestId += 1;
    disconnectNetworkTimelineReaders();
    networkMachineRuntime.set(emptyState());
  },
};
