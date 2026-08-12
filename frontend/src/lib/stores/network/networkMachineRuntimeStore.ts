import { get, writable } from 'svelte/store';
import type { RuntimeActivityEvent, RuntimeAdapterGraphFrame } from '@xln/runtime/api/public/runtime-module';
import { compileNetworkMachine, type NetworkMachine, type NetworkMachineStep } from '$lib/network3d/networkMachine';
import {
  disconnectNetworkTimelineReaders,
  networkTimelineSourceFor,
} from '$lib/network3d/networkTimelineLoader';
import {
  recordNetworkTrail,
  scenarioNetworkTimelineSource,
  trailNetworkTimelineSource,
  type NetworkTimelineSource,
  type NetworkTrail,
} from '$lib/network3d/networkTimelineSource';
import { getXLN } from '../bootstrap/xlnRuntimeLoader';
import { networkMachineConfig } from './networkMachineStore';
import { runtimes } from '../runtimeStore';
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

/**
 * Where the machine reads frames from. A live runtime and a recorded scenario both land
 * here, which is why the timeline, the graph and the captions need no mode switch.
 */
const activeSources = new Map<string, NetworkTimelineSource>();

const setSources = (sources: NetworkTimelineSource[]): void => {
  activeSources.clear();
  for (const source of sources) activeSources.set(source.runtimeId, source);
};

const requireSource = (runtimeId: string): NetworkTimelineSource => {
  const source = activeSources.get(runtimeId);
  if (!source) throw new Error(`NETWORK_MACHINE_SOURCE_MISSING:${runtimeId}`);
  return source;
};

export const networkMachineRuntimeOperations = {
  async refresh(): Promise<NetworkMachine> {
    const requestId = ++refreshRequestId;
    networkMachineRuntime.update((state) => ({ ...state, loading: true, error: null }));
    try {
      const runtimeMap = get(runtimes);
      const sorted = Array.from(runtimeMap.values())
        .sort((left, right) => String(left.id).toLowerCase().localeCompare(String(right.id).toLowerCase()));
      const sources: NetworkTimelineSource[] = [];
      const indexes: RuntimeTimelineIndex[] = [];
      for (const runtime of sorted) {
        const source = await networkTimelineSourceFor(runtime);
        // No reader for this runtime means no frames to show, not a broken timeline.
        if (!source) {
          indexes.push({ runtimeId: String(runtime.id).trim().toLowerCase(), frames: [] });
          continue;
        }
        sources.push(source);
        indexes.push(await source.readIndex());
      }
      const machine = compileCurrent(indexes);
      if (requestId !== refreshRequestId) return machine;
      setSources(sources);
      networkMachineRuntime.set({ ...emptyState(), indexes, machine });
      return machine;
    } catch (error) {
      if (requestId === refreshRequestId) networkMachineRuntime.update((state) => ({ ...state, loading: false, error: message(error) }));
      throw error;
    }
  },

  /** Replay a recorded trail. Portable demos take this path — no runtime, no scenario run. */
  async loadTrail(trail: NetworkTrail): Promise<NetworkMachine> {
    const requestId = ++refreshRequestId;
    networkMachineRuntime.update((state) => ({ ...state, loading: true, error: null }));
    try {
      const source = trailNetworkTimelineSource(trail);
      const indexes = [await source.readIndex()];
      const machine = compileCurrent(indexes);
      if (requestId !== refreshRequestId) return machine;
      setSources([source]);
      networkMachineRuntime.set({ ...emptyState(), indexes, machine });
      return machine;
    } catch (error) {
      if (requestId === refreshRequestId) networkMachineRuntime.update((state) => ({ ...state, loading: false, error: message(error) }));
      throw error;
    }
  },

  /** Freeze whatever is loaded into a portable trail. Single-source machines only. */
  async exportTrail(): Promise<NetworkTrail> {
    const sources = Array.from(activeSources.values());
    if (sources.length !== 1) {
      throw new Error(`NETWORK_MACHINE_TRAIL_EXPORT_REQUIRES_SINGLE_SOURCE:${sources.length}`);
    }
    return await recordNetworkTrail(sources[0]!);
  },

  /**
   * Run a scenario in this browser and show it as a network.
   *
   * The recording replaces live sources for the session: a demo is a self-contained world,
   * and mixing it with whatever runtimes happen to be connected would misrepresent both.
   */
  async loadScenario(key: string): Promise<NetworkMachine> {
    const requestId = ++refreshRequestId;
    const scenarioKey = String(key || '').trim();
    if (!scenarioKey) throw new Error('NETWORK_MACHINE_SCENARIO_KEY_REQUIRED');
    networkMachineRuntime.update((state) => ({ ...state, loading: true, error: null }));
    try {
      const xln = await getXLN();
      const runtimeId = `scenario:${scenarioKey}`.toLowerCase();
      const recording = await xln.recordScenario(scenarioKey as never, xln.createEmptyEnv());
      if (recording.frames.length === 0) throw new Error(`NETWORK_MACHINE_SCENARIO_EMPTY:${scenarioKey}`);
      const source = scenarioNetworkTimelineSource(runtimeId, recording.frames);
      const indexes = [await source.readIndex()];
      const machine = compileCurrent(indexes);
      if (requestId !== refreshRequestId) return machine;
      setSources([source]);
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
      const frames = new Map<string, RuntimeAdapterGraphFrame>();
      const activity: RuntimeActivityEvent[] = [];
      for (const [id, selected] of step.selection.byRuntime) {
        if (!selected) continue;
        const source = requireSource(id);
        frames.set(id, await source.readGraphFrame(selected.height));
        // Captions describe the runtime that moved, not every runtime observing the step.
        if (id !== step.activeRuntimeId) continue;
        activity.push(...await source.readActivity(selected.height, selected.height));
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
    activeSources.clear();
    selectionRequestId += 1;
    disconnectNetworkTimelineReaders();
    networkMachineRuntime.set(emptyState());
  },
};
