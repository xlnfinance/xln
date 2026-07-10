import {
  compareRuntimeTimelineFrames,
  mergeRuntimeTimelineIndexes,
  normalizeRuntimeTimelineIndex,
  runtimeTimelineColor,
  selectMergedTimelineEvent,
  type MergedTimelineSelection,
  type RuntimeTimelineFrame,
  type RuntimeTimelineIndex,
} from './runtimeGraphTimeline';

export type NetworkMachineTimelineMode = 'all-frames' | 'graph-changes';

export type NetworkMachineFrameRef = Pick<RuntimeTimelineFrame, 'runtimeId' | 'height' | 'timestamp'>;

export type NetworkMachineCameraCue = {
  position: { x: number; y: number; z: number };
  target: { x: number; y: number; z: number };
  fov?: number;
};

export type NetworkMachineCue = {
  id: string;
  at: NetworkMachineFrameRef;
  until?: NetworkMachineFrameRef;
  title: string;
  subtitle?: string;
  focusEntityIds?: string[];
  focusAccountIds?: string[];
  focusJMachineIds?: string[];
  camera?: NetworkMachineCameraCue;
  accent?: string;
};

export type NetworkMachineConfig = {
  version: 1;
  id: string;
  title: string;
  description?: string;
  runtimeIds?: string[];
  timelineMode: NetworkMachineTimelineMode;
  cues: NetworkMachineCue[];
};

export type NetworkMachineStep = {
  index: number;
  event: RuntimeTimelineFrame;
  selection: MergedTimelineSelection;
  activeRuntimeId: string;
  activeRuntimeColor: string;
  cues: NetworkMachineCue[];
};

export type NetworkMachine = {
  config: NetworkMachineConfig;
  indexes: RuntimeTimelineIndex[];
  steps: NetworkMachineStep[];
};

export const NETWORK_MACHINE_CONFIG_KEY = 'xln-network-machine-config-v1';

export const DEFAULT_NETWORK_MACHINE_CONFIG: NetworkMachineConfig = {
  version: 1,
  id: 'network-machine',
  title: 'Network Machine',
  timelineMode: 'all-frames',
  cues: [],
};

const nonEmpty = (value: unknown, field: string): string => {
  const normalized = String(value ?? '').trim();
  if (!normalized) throw new Error(`NETWORK_MACHINE_${field.toUpperCase()}_REQUIRED`);
  return normalized;
};

const finiteCoordinate = (value: unknown, field: string): number => {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) throw new Error(`NETWORK_MACHINE_${field.toUpperCase()}_INVALID`);
  return parsed;
};

const normalizeRef = (value: NetworkMachineFrameRef, field: string): NetworkMachineFrameRef => {
  const runtimeId = nonEmpty(value?.runtimeId, `${field}_runtime_id`).toLowerCase();
  const height = Math.floor(finiteCoordinate(value?.height, `${field}_height`));
  const timestamp = Math.floor(finiteCoordinate(value?.timestamp, `${field}_timestamp`));
  if (height < 1 || timestamp < 1) throw new Error(`NETWORK_MACHINE_${field.toUpperCase()}_INVALID`);
  return { runtimeId, height, timestamp };
};

const normalizeIds = (values: string[] | undefined): string[] | undefined => {
  if (!values) return undefined;
  return Array.from(new Set(values.map((value) => nonEmpty(value, 'runtime_id').toLowerCase())))
    .sort((left, right) => left.localeCompare(right));
};

const normalizeFocusIds = (values: string[] | undefined): string[] | undefined => {
  if (!values) return undefined;
  return Array.from(new Set(values.map((value) => nonEmpty(value, 'focus_id').toLowerCase())))
    .sort((left, right) => left.localeCompare(right));
};

const normalizeCamera = (camera: NetworkMachineCameraCue | undefined): NetworkMachineCameraCue | undefined => {
  if (!camera) return undefined;
  const point = (value: { x: number; y: number; z: number }, field: string) => ({
    x: finiteCoordinate(value?.x, `${field}_x`),
    y: finiteCoordinate(value?.y, `${field}_y`),
    z: finiteCoordinate(value?.z, `${field}_z`),
  });
  const fov = camera.fov === undefined ? undefined : finiteCoordinate(camera.fov, 'camera_fov');
  if (fov !== undefined && (fov <= 0 || fov >= 180)) throw new Error('NETWORK_MACHINE_CAMERA_FOV_INVALID');
  return { position: point(camera.position, 'camera_position'), target: point(camera.target, 'camera_target'), ...(fov === undefined ? {} : { fov }) };
};

const refAsFrame = (ref: NetworkMachineFrameRef): RuntimeTimelineFrame => ({
  ...ref,
  stateHash: '',
  materialized: false,
});

const normalizeCue = (cue: NetworkMachineCue): NetworkMachineCue => {
  const at = normalizeRef(cue.at, 'cue_at');
  const until = cue.until ? normalizeRef(cue.until, 'cue_until') : undefined;
  const focusEntityIds = normalizeFocusIds(cue.focusEntityIds);
  const focusAccountIds = normalizeFocusIds(cue.focusAccountIds);
  const focusJMachineIds = normalizeFocusIds(cue.focusJMachineIds);
  const camera = normalizeCamera(cue.camera);
  if (until && compareRuntimeTimelineFrames(refAsFrame(until), refAsFrame(at)) < 0) {
    throw new Error('NETWORK_MACHINE_CUE_RANGE_INVALID');
  }
  return {
    id: nonEmpty(cue.id, 'cue_id'),
    at,
    ...(until ? { until } : {}),
    title: nonEmpty(cue.title, 'cue_title'),
    ...(cue.subtitle?.trim() ? { subtitle: cue.subtitle.trim() } : {}),
    ...(focusEntityIds ? { focusEntityIds } : {}),
    ...(focusAccountIds ? { focusAccountIds } : {}),
    ...(focusJMachineIds ? { focusJMachineIds } : {}),
    ...(camera ? { camera } : {}),
    ...(cue.accent?.trim() ? { accent: cue.accent.trim() } : {}),
  };
};

export const normalizeNetworkMachineConfig = (config: NetworkMachineConfig): NetworkMachineConfig => {
  if (config?.version !== 1) throw new Error('NETWORK_MACHINE_VERSION_UNSUPPORTED');
  if (config.timelineMode !== 'all-frames' && config.timelineMode !== 'graph-changes') {
    throw new Error('NETWORK_MACHINE_TIMELINE_MODE_INVALID');
  }
  const cues = (config.cues ?? []).map(normalizeCue)
    .sort((left, right) => compareRuntimeTimelineFrames(refAsFrame(left.at), refAsFrame(right.at)) || left.id.localeCompare(right.id));
  const runtimeIds = normalizeIds(config.runtimeIds);
  if (new Set(cues.map((cue) => cue.id)).size !== cues.length) throw new Error('NETWORK_MACHINE_CUE_ID_DUPLICATE');
  return {
    version: 1,
    id: nonEmpty(config.id, 'id'),
    title: nonEmpty(config.title, 'title'),
    ...(config.description?.trim() ? { description: config.description.trim() } : {}),
    ...(runtimeIds ? { runtimeIds } : {}),
    timelineMode: config.timelineMode,
    cues,
  };
};

const cueIsActive = (cue: NetworkMachineCue, event: RuntimeTimelineFrame): boolean => {
  if (compareRuntimeTimelineFrames(event, refAsFrame(cue.at)) < 0) return false;
  return !cue.until || compareRuntimeTimelineFrames(event, refAsFrame(cue.until)) <= 0;
};

const filterIndexes = (indexes: RuntimeTimelineIndex[], runtimeIds: string[] | undefined): RuntimeTimelineIndex[] => {
  const allowed = runtimeIds ? new Set(runtimeIds) : null;
  return indexes.map(normalizeRuntimeTimelineIndex)
    .filter((index) => !allowed || allowed.has(index.runtimeId))
    .sort((left, right) => left.runtimeId.localeCompare(right.runtimeId));
};

export const compileNetworkMachine = (
  indexes: RuntimeTimelineIndex[],
  input: NetworkMachineConfig,
): NetworkMachine => {
  const config = normalizeNetworkMachineConfig(input);
  const selectedIndexes = filterIndexes(indexes, config.runtimeIds);
  const events = mergeRuntimeTimelineIndexes(selectedIndexes)
    .map((event) => event.changed[0]!)
    .filter((event) => config.timelineMode === 'all-frames' || event.graphChanged === true);
  const steps = events.map((event, index): NetworkMachineStep => ({
    index,
    event,
    selection: selectMergedTimelineEvent(selectedIndexes, event),
    activeRuntimeId: event.runtimeId,
    activeRuntimeColor: runtimeTimelineColor(event.runtimeId),
    cues: config.cues.filter((cue) => cueIsActive(cue, event)),
  }));
  return { config, indexes: selectedIndexes, steps };
};

export const parseNetworkMachineConfig = (value: string): NetworkMachineConfig => {
  const parsed: unknown = JSON.parse(value);
  if (!parsed || typeof parsed !== 'object') throw new Error('NETWORK_MACHINE_CONFIG_INVALID');
  return normalizeNetworkMachineConfig(parsed as NetworkMachineConfig);
};
