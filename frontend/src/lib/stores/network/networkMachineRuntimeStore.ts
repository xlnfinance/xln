import { get, writable } from 'svelte/store';
import type { RuntimeActivityEvent, RuntimeAdapterGraphFrame } from '@xln/core/api/public/runtime-module';
import { compileNetworkMachine, presentationNetworkMachine, type NetworkMachine, type NetworkMachineStep } from '$lib/network3d/networkMachine';
import { networkMachinePresentation } from './networkMachineDemoStore';
import {
  disconnectNetworkTimelineReaders,
  networkTimelineSourceFor,
} from '$lib/network3d/timeline/networkTimelineLoader';
import {
  recordNetworkTrail,
  scenarioNetworkTimelineSource,
  trailNetworkTimelineSource,
  type NetworkTimelineSource,
  type NetworkTrail,
} from '$lib/network3d/timeline/networkTimelineSource';
import { getXLN } from '../bootstrap/xlnRuntimeLoader';
import { networkMachineConfig, networkMachineOperations } from './networkMachineStore';
import { runtimes } from '../runtimeStore';
import type { RuntimeTimelineIndex } from '$lib/network3d/timeline/runtimeGraphTimeline';
import { deriveNetworkStepMotion, type NetworkStepMotion } from '$lib/network3d/timeline/networkStepMotion';
import { projectRuntimeGraphFrame, type RuntimeGraphProjection } from '$lib/network3d/runtimeGraphProjection';

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
  /** What the selected step moved, against the R-frame before it — the graph's motion source. */
  motion: NetworkStepMotion | null;
  /** Graph frame per runtime one R-frame before the selected step: what a change is measured from. */
  previousFrames: Map<string, RuntimeAdapterGraphFrame>;
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
  motion: null,
  previousFrames: new Map(),
});

const projectFrames = (frames: ReadonlyMap<string, RuntimeAdapterGraphFrame>): RuntimeGraphProjection[] =>
  Array.from(frames, ([runtimeId, frame]) => projectRuntimeGraphFrame(frame, { runtimeId, adapterKind: 'browser' }));

/** The R-frame the active runtime committed just before the selected one, if any. */
const predecessorHeight = (indexes: RuntimeTimelineIndex[], step: NetworkMachineStep): number | null => {
  const frames = indexes.find((index) => index.runtimeId === step.activeRuntimeId)?.frames ?? [];
  const position = frames.findIndex((frame) => frame.height === step.event.height);
  return position > 0 ? frames[position - 1]!.height : null;
};

/**
 * Only the active runtime moved at this step, so the previous network state is the current
 * one with that runtime rewound by one R-frame.
 */
const readStepMotion = async (
  indexes: RuntimeTimelineIndex[],
  step: NetworkMachineStep,
  frames: Map<string, RuntimeAdapterGraphFrame>,
  activity: RuntimeActivityEvent[],
): Promise<{ motion: NetworkStepMotion; previousFrames: Map<string, RuntimeAdapterGraphFrame> }> => {
  const key = `${step.activeRuntimeId}:h${step.event.height}`;
  const previousHeight = predecessorHeight(indexes, step);
  if (previousHeight === null) {
    return { motion: deriveNetworkStepMotion({ key, previous: null, current: projectFrames(frames), activity }), previousFrames: new Map() };
  }
  const previousFrames = new Map(frames);
  previousFrames.set(step.activeRuntimeId, await requireSource(step.activeRuntimeId).readGraphFrame(previousHeight));
  return {
    motion: deriveNetworkStepMotion({ key, previous: projectFrames(previousFrames), current: projectFrames(frames), activity }),
    previousFrames,
  };
};

const message = (error: unknown): string => error instanceof Error ? error.message : String(error || 'NetworkMachine failed');

export const networkMachineRuntime = writable<NetworkMachineRuntimeState>(emptyState());

export const assertNetworkMachineIsLive = (
  state: Pick<NetworkMachineRuntimeState, 'selectedStep'>,
): void => {
  if (!state.selectedStep) return;
  const event = state.selectedStep.event;
  throw new Error(`RUNTIME_COMMAND_REQUIRES_LIVE_VIEW: network-machine=${event.runtimeId}:h${event.height}`);
};

/** A presentation plays only the story: from its setup summary to its closing cue. */
const compileCurrent = (indexes: RuntimeTimelineIndex[]): NetworkMachine => {
  const machine = compileNetworkMachine(indexes, get(networkMachineConfig));
  return get(networkMachinePresentation) ? presentationNetworkMachine(machine) : machine;
};

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

const installSourceCues = (source: NetworkTimelineSource): void => {
  networkMachineOperations.replace({
    ...get(networkMachineConfig),
    runtimeIds: [source.runtimeId],
    cues: source.cues ?? [],
  });
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
      installSourceCues(source);
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
      const source = scenarioNetworkTimelineSource(runtimeId, recording.frames, recording.narration);
      installSourceCues(source);
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
      const { motion, previousFrames } = await readStepMotion(current.indexes, step, frames, activity);
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
        motion,
        previousFrames,
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
      motion: null,
      previousFrames: new Map(),
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
