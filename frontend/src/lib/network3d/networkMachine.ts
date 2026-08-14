import {
  compareRuntimeTimelineFrames,
  mergeRuntimeTimelineIndexes,
  normalizeRuntimeTimelineIndex,
  runtimeTimelineColor,
  selectMergedTimelineEvent,
  type MergedTimelineSelection,
  type RuntimeTimelineFrame,
  type RuntimeTimelineIndex,
} from './timeline/runtimeGraphTimeline';
import { parseJsonUnknown, rejectExtraKeys, requireUnknownRecord } from '$lib/utils/boundary';

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
  const config = requireUnknownRecord(parseJsonUnknown(value, 'NETWORK_MACHINE_CONFIG_JSON_INVALID'), 'NETWORK_MACHINE_CONFIG_INVALID');
  rejectExtraKeys(config, ['version', 'id', 'title', 'description', 'runtimeIds', 'timelineMode', 'cues'], 'NETWORK_MACHINE_CONFIG_EXTRA_FIELD');
  if (config['version'] !== 1 || typeof config['id'] !== 'string' || typeof config['title'] !== 'string' ||
    (config['description'] !== undefined && typeof config['description'] !== 'string') ||
    (config['runtimeIds'] !== undefined && (!Array.isArray(config['runtimeIds']) || !config['runtimeIds'].every((id) => typeof id === 'string'))) ||
    (config['timelineMode'] !== 'all-frames' && config['timelineMode'] !== 'graph-changes') || !Array.isArray(config['cues'])) {
    throw new Error('NETWORK_MACHINE_CONFIG_FIELD_INVALID');
  }
  return normalizeNetworkMachineConfig({
    version: 1,
    id: config['id'],
    title: config['title'],
    ...(config['description'] === undefined ? {} : { description: config['description'] }),
    ...(config['runtimeIds'] === undefined ? {} : { runtimeIds: config['runtimeIds'] }),
    timelineMode: config['timelineMode'],
    cues: config['cues'].map(decodeNetworkMachineCue),
  });
};

const decodeNetworkMachineFrameRef = (value: unknown, field: string): NetworkMachineFrameRef => {
  const record = requireUnknownRecord(value, `NETWORK_MACHINE_${field}_INVALID`);
  rejectExtraKeys(record, ['runtimeId', 'height', 'timestamp'], `NETWORK_MACHINE_${field}_EXTRA_FIELD`);
  if (typeof record['runtimeId'] !== 'string' || typeof record['height'] !== 'number' || !Number.isFinite(record['height']) ||
    typeof record['timestamp'] !== 'number' || !Number.isFinite(record['timestamp'])) throw new Error(`NETWORK_MACHINE_${field}_FIELD_INVALID`);
  return { runtimeId: record['runtimeId'], height: record['height'], timestamp: record['timestamp'] };
};

const decodeNetworkMachinePoint = (value: unknown, field: string): { x: number; y: number; z: number } => {
  const record = requireUnknownRecord(value, `NETWORK_MACHINE_${field}_INVALID`);
  rejectExtraKeys(record, ['x', 'y', 'z'], `NETWORK_MACHINE_${field}_EXTRA_FIELD`);
  if (typeof record['x'] !== 'number' || !Number.isFinite(record['x']) || typeof record['y'] !== 'number' || !Number.isFinite(record['y']) ||
    typeof record['z'] !== 'number' || !Number.isFinite(record['z'])) throw new Error(`NETWORK_MACHINE_${field}_FIELD_INVALID`);
  return { x: record['x'], y: record['y'], z: record['z'] };
};

const decodeNetworkMachineCue = (value: unknown): NetworkMachineCue => {
  const record = requireUnknownRecord(value, 'NETWORK_MACHINE_CUE_INVALID');
  rejectExtraKeys(record, ['id', 'at', 'until', 'title', 'subtitle', 'focusEntityIds', 'focusAccountIds', 'focusJMachineIds', 'camera', 'accent'], 'NETWORK_MACHINE_CUE_EXTRA_FIELD');
  const stringArray = (name: string): string[] | undefined => {
    const values = record[name];
    if (values === undefined) return undefined;
    if (!Array.isArray(values) || !values.every((entry) => typeof entry === 'string')) throw new Error(`NETWORK_MACHINE_CUE_${name.toUpperCase()}_INVALID`);
    return values;
  };
  if (typeof record['id'] !== 'string' || typeof record['title'] !== 'string' ||
    (record['subtitle'] !== undefined && typeof record['subtitle'] !== 'string') ||
    (record['accent'] !== undefined && typeof record['accent'] !== 'string')) throw new Error('NETWORK_MACHINE_CUE_FIELD_INVALID');
  const focusEntityIds = stringArray('focusEntityIds');
  const focusAccountIds = stringArray('focusAccountIds');
  const focusJMachineIds = stringArray('focusJMachineIds');
  let camera: NetworkMachineCameraCue | undefined;
  if (record['camera'] !== undefined) {
    const rawCamera = requireUnknownRecord(record['camera'], 'NETWORK_MACHINE_CAMERA_INVALID');
    rejectExtraKeys(rawCamera, ['position', 'target', 'fov'], 'NETWORK_MACHINE_CAMERA_EXTRA_FIELD');
    if (rawCamera['fov'] !== undefined && (typeof rawCamera['fov'] !== 'number' || !Number.isFinite(rawCamera['fov']))) throw new Error('NETWORK_MACHINE_CAMERA_FOV_INVALID');
    camera = {
      position: decodeNetworkMachinePoint(rawCamera['position'], 'camera_position'),
      target: decodeNetworkMachinePoint(rawCamera['target'], 'camera_target'),
      ...(rawCamera['fov'] === undefined ? {} : { fov: rawCamera['fov'] }),
    };
  }
  return {
    id: record['id'],
    at: decodeNetworkMachineFrameRef(record['at'], 'cue_at'),
    ...(record['until'] === undefined ? {} : { until: decodeNetworkMachineFrameRef(record['until'], 'cue_until') }),
    title: record['title'],
    ...(record['subtitle'] === undefined ? {} : { subtitle: record['subtitle'] }),
    ...(focusEntityIds === undefined ? {} : { focusEntityIds }),
    ...(focusAccountIds === undefined ? {} : { focusAccountIds }),
    ...(focusJMachineIds === undefined ? {} : { focusJMachineIds }),
    ...(camera === undefined ? {} : { camera }),
    ...(record['accent'] === undefined ? {} : { accent: record['accent'] }),
  };
};
