import type { EnvSnapshot, RuntimeReplica, XLNModule } from '@xln/core/api/public/runtime-module';
import { isXLNModuleLoaded } from '@xln/core/api/public/runtime-module-guard';

import {
  EMPTY_SCENARIO_VISUAL,
  DEFAULT_SCENARIO_ID,
  buildScenarioFrameVisual,
  clampScenarioFrameIndex,
  focusScenarioFrameIndex,
  formatScenarioBuilderText,
  readScenarioPreviewRequest,
  requireScenarioOption,
  scenarioPreviewHref,
  type ScenarioFrameVisual,
  type ScenarioId,
  type ScenarioOption,
} from '../../runtime-client/src/scenario-player-model';
import {
  formatScenarioError,
  recordBrowserScenario,
  stopScenarioPreviewInfra,
} from '../../runtime-client/src/scenario-runtime';
import { createBrowserRuntimeModuleLoader } from './runtime-module-loader';

export type RuntimeScenarioSnapshot = Readonly<{
  status: 'idle' | 'loading' | 'ready' | 'error';
  option: ScenarioOption;
  frameCount: number;
  currentFrame: number;
  height: number;
  playing: boolean;
  playbackMs: number;
  statusText: string;
  error: string;
  diagnostics: readonly string[];
  visual: ScenarioFrameVisual;
  inspectText: string;
  previewHref: string;
}>;

export type RuntimeScenarioSourceDependencies = Readonly<{
  loadRuntime: () => Promise<XLNModule>;
  now: () => number;
  setTimer: (callback: () => void, milliseconds: number) => number;
  clearTimer: (handle: number) => void;
  publishFrame?: (env: RuntimeReplica, frames: readonly EnvSnapshot[], index: number) => void;
  reportTiming?: (id: ScenarioId, elapsedMs: number) => void;
}>;

export type RuntimeScenarioSource = Readonly<{
  getSnapshot: () => RuntimeScenarioSnapshot;
  subscribe: (listener: () => void) => () => void;
  start: (id?: ScenarioId, frame?: number | null) => Promise<void>;
  startFromRouteRequest: (id: string, frame: string | null) => Promise<void>;
  startFromPreviewSearch: (search: string) => Promise<void>;
  stop: () => void;
  loadScenario: (id: ScenarioId, frame?: number | null) => Promise<void>;
  goToFrame: (index: number) => void;
  step: (delta: number) => void;
  restart: () => void;
  play: () => void;
  pause: () => void;
  setPlaybackMs: (milliseconds: number) => void;
}>;

const runtimeLoader = createBrowserRuntimeModuleLoader<XLNModule>({
  validate: isXLNModuleLoaded,
  readSchemaVersion: runtime => runtime.RUNTIME_SCHEMA_VERSION,
});

const defaultDependencies = (): RuntimeScenarioSourceDependencies => ({
  loadRuntime: runtimeLoader.load,
  now: () => performance.now(),
  setTimer: (callback, milliseconds) => window.setInterval(callback, milliseconds),
  clearTimer: handle => window.clearInterval(handle),
  reportTiming: (id, elapsedMs) => console.info(`E2E-TIMING:scenario_player.${id}=${Math.round(elapsedMs)}ms`),
});

const initialSnapshot = (id: ScenarioId = DEFAULT_SCENARIO_ID): RuntimeScenarioSnapshot => {
  const option = requireScenarioOption(id);
  return {
    status: 'idle', option, frameCount: 0, currentFrame: 0, height: 0, playing: false,
    playbackMs: 700, statusText: 'Ready to run', error: '', diagnostics: [], visual: EMPTY_SCENARIO_VISUAL,
    inspectText: 'No frame loaded.', previewHref: scenarioPreviewHref(option.id, 0),
  };
};

export const createRuntimeScenarioSource = (
  dependencies: RuntimeScenarioSourceDependencies = defaultDependencies(),
): RuntimeScenarioSource => {
  const listeners = new Set<() => void>();
  let snapshot = initialSnapshot();
  let frames: readonly EnvSnapshot[] = [];
  let environment: RuntimeReplica | null = null;
  let generation = 0;
  let started = false;
  let timer: number | null = null;
  let restartFrame = 0;

  const publish = (patch: Partial<RuntimeScenarioSnapshot>): void => {
    snapshot = { ...snapshot, ...patch };
    for (const listener of listeners) listener();
  };
  const pause = (): void => {
    if (timer !== null) dependencies.clearTimer(timer);
    timer = null;
    if (snapshot.playing) publish({ playing: false });
  };
  const goToFrame = (index: number): void => {
    if (frames.length === 0) return;
    const currentFrame = clampScenarioFrameIndex(index, frames.length);
    const frame = frames[currentFrame]!;
    const visual = buildScenarioFrameVisual(frame, snapshot.option);
    dependencies.publishFrame?.(environment!, frames, currentFrame);
    publish({
      currentFrame, height: frame.state.height, visual,
      inspectText: formatScenarioBuilderText(frame, visual, snapshot.option, currentFrame, frames.length),
      previewHref: scenarioPreviewHref(snapshot.option.id, currentFrame),
    });
  };
  const loadScenario = async (id: ScenarioId, requestedFrame: number | null = null): Promise<void> => {
    const ownedGeneration = ++generation;
    const option = requireScenarioOption(id);
    const startedAt = dependencies.now();
    pause();
    const cleanup = stopScenarioPreviewInfra(environment, 'previous scenario');
    environment = null;
    frames = [];
    publish({ ...initialSnapshot(id), status: 'loading', playbackMs: snapshot.playbackMs, statusText: `Running ${option.title}`, diagnostics: cleanup });
    try {
      const recording = await recordBrowserScenario(await dependencies.loadRuntime(), option);
      const diagnostics = [...cleanup, ...stopScenarioPreviewInfra(recording.env, option.title)].slice(-6);
      if (!started || ownedGeneration !== generation) {
        stopScenarioPreviewInfra(recording.env, 'superseded scenario');
        return;
      }
      if (recording.frames.length === 0) throw new Error(`SCENARIO_EMPTY_HISTORY:${option.id}`);
      environment = recording.env;
      frames = recording.frames;
      restartFrame = focusScenarioFrameIndex(option, frames);
      const currentFrame = requestedFrame === null
        ? restartFrame
        : clampScenarioFrameIndex(requestedFrame, frames.length);
      const frame = frames[currentFrame]!;
      const visual = buildScenarioFrameVisual(frame, option);
      dependencies.publishFrame?.(environment, frames, currentFrame);
      publish({
        status: 'ready', option, frameCount: frames.length, currentFrame, height: frame.state.height,
        playing: false, statusText: `${option.title}: ${frames.length} frames`, error: '', diagnostics, visual,
        inspectText: formatScenarioBuilderText(frame, visual, option, currentFrame, frames.length),
        previewHref: scenarioPreviewHref(option.id, currentFrame),
      });
      dependencies.reportTiming?.(option.id, dependencies.now() - startedAt);
    } catch (error: unknown) {
      if (started && ownedGeneration === generation) {
        publish({ status: 'error', statusText: 'Scenario failed', error: formatScenarioError(error), playing: false });
      }
    }
  };
  const play = (): void => {
    if (timer !== null || snapshot.status !== 'ready' || frames.length <= 1) return;
    publish({ playing: true });
    timer = dependencies.setTimer(() => {
      if (snapshot.currentFrame >= frames.length - 1) pause();
      else goToFrame(snapshot.currentFrame + 1);
    }, snapshot.playbackMs);
  };
  return {
    getSnapshot: () => snapshot,
    subscribe: listener => { listeners.add(listener); return () => listeners.delete(listener); },
    start: async (id = DEFAULT_SCENARIO_ID, frame = null) => { if (!started) { started = true; await loadScenario(id, frame); } },
    startFromRouteRequest: async (id, rawFrame) => {
      if (started) return;
      started = true;
      try {
        const option = requireScenarioOption(id || DEFAULT_SCENARIO_ID);
        if (rawFrame !== null && (!/^\d+$/.test(rawFrame) || !Number.isSafeInteger(Number(rawFrame)))) {
          throw new Error(`RUNTIME_SCENARIO_FRAME_INVALID:${rawFrame}`);
        }
        await loadScenario(option.id, rawFrame === null ? null : Number(rawFrame));
      } catch (error: unknown) {
        publish({ status: 'error', statusText: 'Scenario failed', error: formatScenarioError(error) });
      }
    },
    startFromPreviewSearch: async search => {
      if (started) return;
      started = true;
      try {
        const request = readScenarioPreviewRequest(search);
        await loadScenario(request.id, request.frame);
      } catch (error: unknown) {
        publish({ status: 'error', statusText: 'Scenario preview failed', error: formatScenarioError(error) });
      }
    },
    stop: () => {
      if (!started) return;
      started = false; generation += 1; pause(); stopScenarioPreviewInfra(environment, 'scenario teardown');
      environment = null; frames = []; publish(initialSnapshot(snapshot.option.id));
    },
    loadScenario,
    goToFrame,
    step: delta => goToFrame(snapshot.currentFrame + delta),
    restart: () => { pause(); goToFrame(restartFrame); },
    play,
    pause,
    setPlaybackMs: milliseconds => {
      if (![350, 700, 1000].includes(milliseconds)) throw new Error(`SCENARIO_PLAYBACK_INVALID:${milliseconds}`);
      const resume = snapshot.playing; pause(); publish({ playbackMs: milliseconds }); if (resume) play();
    },
  };
};
