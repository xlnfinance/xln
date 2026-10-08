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

/** One rung of a narrated ladder (bilateral → on-chain → legal finality). */
export type NetworkMachineCueBadge = {
  label: string;
  detail: string;
  tone: 'done' | 'bounded' | 'outside';
};

export type NetworkMachineCue = {
  id: string;
  at: NetworkMachineFrameRef;
  until?: NetworkMachineFrameRef;
  title: string;
  subtitle?: string;
  what?: string;
  why?: string;
  tradfiParallel?: string;
  keyMetrics?: string[];
  focusEntityIds?: string[];
  focusAccountIds?: string[];
  focusJMachineIds?: string[];
  camera?: NetworkMachineCameraCue;
  accent?: string;
  badges?: NetworkMachineCueBadge[];
  /** A presentation starts at this cue: every earlier step is setup it summarises. */
  condensePrior?: boolean;
  /** A presentation ends at this cue; later frames stay in the full timeline only. */
  endsPresentation?: boolean;
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

const BADGE_TONES = new Set(['done', 'bounded', 'outside']);

const normalizeBadges = (badges: NetworkMachineCueBadge[] | undefined): NetworkMachineCueBadge[] | undefined => {
  if (!badges) return undefined;
  return badges.map((badge) => {
    if (!BADGE_TONES.has(badge?.tone)) throw new Error('NETWORK_MACHINE_CUE_BADGE_TONE_INVALID');
    return { label: nonEmpty(badge.label, 'cue_badge_label'), detail: nonEmpty(badge.detail, 'cue_badge_detail'), tone: badge.tone };
  });
};

const normalizeCue = (cue: NetworkMachineCue): NetworkMachineCue => {
  const at = normalizeRef(cue.at, 'cue_at');
  const until = cue.until ? normalizeRef(cue.until, 'cue_until') : undefined;
  const focusEntityIds = normalizeFocusIds(cue.focusEntityIds);
  const focusAccountIds = normalizeFocusIds(cue.focusAccountIds);
  const focusJMachineIds = normalizeFocusIds(cue.focusJMachineIds);
  const camera = normalizeCamera(cue.camera);
  const badges = normalizeBadges(cue.badges);
  if (until && compareRuntimeTimelineFrames(refAsFrame(until), refAsFrame(at)) < 0) {
    throw new Error('NETWORK_MACHINE_CUE_RANGE_INVALID');
  }
  return {
    id: nonEmpty(cue.id, 'cue_id'),
    at,
    ...(until ? { until } : {}),
    title: nonEmpty(cue.title, 'cue_title'),
    ...(cue.subtitle?.trim() ? { subtitle: cue.subtitle.trim() } : {}),
    ...(cue.what?.trim() ? { what: cue.what.trim() } : {}),
    ...(cue.why?.trim() ? { why: cue.why.trim() } : {}),
    ...(cue.tradfiParallel?.trim() ? { tradfiParallel: cue.tradfiParallel.trim() } : {}),
    ...(cue.keyMetrics ? { keyMetrics: cue.keyMetrics.map((metric) => nonEmpty(metric, 'cue_metric')) } : {}),
    ...(focusEntityIds ? { focusEntityIds } : {}),
    ...(focusAccountIds ? { focusAccountIds } : {}),
    ...(focusJMachineIds ? { focusJMachineIds } : {}),
    ...(camera ? { camera } : {}),
    ...(cue.accent?.trim() ? { accent: cue.accent.trim() } : {}),
    ...(badges ? { badges } : {}),
    ...(cue.condensePrior === true ? { condensePrior: true } : {}),
    ...(cue.endsPresentation === true ? { endsPresentation: true } : {}),
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

/**
 * The cue that speaks for a step. Cues stay active until their `until`, so several overlap;
 * the most recent one is the current narration — the earlier ones are history.
 */
export const activeNetworkMachineCue = (cues: readonly NetworkMachineCue[]): NetworkMachineCue | null => {
  for (let index = cues.length - 1; index >= 0; index -= 1) {
    const cue = cues[index]!;
    if (cue.title.trim()) return cue;
  }
  return null;
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
  const steps = events.flatMap((event) => {
    const selection = selectMergedTimelineEvent(selectedIndexes, event);
    return cueBeatsAt(config.cues, event).map((cues) => ({ event, selection, cues }));
  }).map(({ event, selection, cues }, index): NetworkMachineStep => ({
    index,
    event,
    selection,
    activeRuntimeId: event.runtimeId,
    activeRuntimeColor: runtimeTimelineColor(event.runtimeId),
    cues,
  }));
  return { config, indexes: selectedIndexes, steps };
};

const startsAt = (cue: NetworkMachineCue, event: RuntimeTimelineFrame): boolean =>
  compareRuntimeTimelineFrames(event, refAsFrame(cue.at)) === 0;

/**
 * The cue lists one frame presents. A frame normally is one step; when several cues begin on
 * it (an announcement, then beats about the state it applied), each cue is a step of its own,
 * spoken in order, so a narrated outcome never shares a card with the action before it.
 */
const cueBeatsAt = (cues: readonly NetworkMachineCue[], event: RuntimeTimelineFrame): NetworkMachineCue[][] => {
  const active = cues.filter((cue) => cueIsActive(cue, event));
  const starting = active.filter((cue) => startsAt(cue, event));
  if (starting.length <= 1) return [active];
  return starting.map((beat) => {
    const later = new Set(starting.slice(starting.indexOf(beat) + 1));
    return active.filter((cue) => !later.has(cue));
  });
};

/**
 * Presentation: the steps between the last condensing cue and the first ending cue. The
 * condensing cue summarises the setup frames before it, so the audience starts at the state
 * the story is about; an ending cue closes the story before later test frames.
 */
export const presentationNetworkMachine = (machine: NetworkMachine): NetworkMachine => {
  let start = 0;
  let end = machine.steps.length;
  machine.steps.forEach((step, index) => {
    const cue = activeNetworkMachineCue(step.cues);
    if (!cue || !startsAt(cue, step.event)) return;
    if (cue.condensePrior === true) start = index;
    if (cue.endsPresentation === true && end === machine.steps.length) end = index + 1;
  });
  if (start === 0 && end === machine.steps.length) return machine;
  if (end <= start) throw new Error(`NETWORK_MACHINE_PRESENTATION_RANGE_INVALID:${start}:${end}`);
  return { ...machine, steps: machine.steps.slice(start, end).map((step, index) => ({ ...step, index })) };
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

export const decodeNetworkMachineCue = (value: unknown): NetworkMachineCue => {
  const record = requireUnknownRecord(value, 'NETWORK_MACHINE_CUE_INVALID');
  rejectExtraKeys(record, ['id', 'at', 'until', 'title', 'subtitle', 'what', 'why', 'tradfiParallel', 'keyMetrics', 'focusEntityIds', 'focusAccountIds', 'focusJMachineIds', 'camera', 'accent', 'badges', 'condensePrior', 'endsPresentation'], 'NETWORK_MACHINE_CUE_EXTRA_FIELD');
  const stringArray = (name: string): string[] | undefined => {
    const values = record[name];
    if (values === undefined) return undefined;
    if (!Array.isArray(values) || !values.every((entry) => typeof entry === 'string')) throw new Error(`NETWORK_MACHINE_CUE_${name.toUpperCase()}_INVALID`);
    return values;
  };
  if (typeof record['id'] !== 'string' || typeof record['title'] !== 'string' ||
    (record['subtitle'] !== undefined && typeof record['subtitle'] !== 'string') ||
    (record['what'] !== undefined && typeof record['what'] !== 'string') ||
    (record['why'] !== undefined && typeof record['why'] !== 'string') ||
    (record['tradfiParallel'] !== undefined && typeof record['tradfiParallel'] !== 'string') ||
    (record['keyMetrics'] !== undefined && (!Array.isArray(record['keyMetrics']) || !record['keyMetrics'].every((metric) => typeof metric === 'string'))) ||
    (record['accent'] !== undefined && typeof record['accent'] !== 'string') ||
    (record['condensePrior'] !== undefined && record['condensePrior'] !== true) ||
    (record['endsPresentation'] !== undefined && record['endsPresentation'] !== true)) throw new Error('NETWORK_MACHINE_CUE_FIELD_INVALID');
  const badges = decodeNetworkMachineCueBadges(record['badges']);
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
    ...(record['what'] === undefined ? {} : { what: record['what'] }),
    ...(record['why'] === undefined ? {} : { why: record['why'] }),
    ...(record['tradfiParallel'] === undefined ? {} : { tradfiParallel: record['tradfiParallel'] }),
    ...(record['keyMetrics'] === undefined ? {} : { keyMetrics: record['keyMetrics'] as string[] }),
    ...(focusEntityIds === undefined ? {} : { focusEntityIds }),
    ...(focusAccountIds === undefined ? {} : { focusAccountIds }),
    ...(focusJMachineIds === undefined ? {} : { focusJMachineIds }),
    ...(camera === undefined ? {} : { camera }),
    ...(record['accent'] === undefined ? {} : { accent: record['accent'] }),
    ...(badges === undefined ? {} : { badges }),
    ...(record['condensePrior'] === true ? { condensePrior: true } : {}),
    ...(record['endsPresentation'] === true ? { endsPresentation: true } : {}),
  };
};

const decodeNetworkMachineCueBadges = (value: unknown): NetworkMachineCueBadge[] | undefined => {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) throw new Error('NETWORK_MACHINE_CUE_BADGES_INVALID');
  return value.map((entry) => {
    const badge = requireUnknownRecord(entry, 'NETWORK_MACHINE_CUE_BADGE_INVALID');
    rejectExtraKeys(badge, ['label', 'detail', 'tone'], 'NETWORK_MACHINE_CUE_BADGE_EXTRA_FIELD');
    const tone = badge['tone'];
    if (typeof badge['label'] !== 'string' || typeof badge['detail'] !== 'string' ||
      (tone !== 'done' && tone !== 'bounded' && tone !== 'outside')) throw new Error('NETWORK_MACHINE_CUE_BADGE_FIELD_INVALID');
    return { label: badge['label'], detail: badge['detail'], tone };
  });
};
