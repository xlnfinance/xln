export type RuntimeTimelineFrame = {
  runtimeId: string;
  height: number;
  timestamp: number;
  stateHash: string;
  materialized: boolean;
  graphChanged?: boolean;
};

export type RuntimeTimelineIndex = {
  runtimeId: string;
  frames: RuntimeTimelineFrame[];
};

export type MergedTimelineEvent = {
  timestamp: number;
  changed: RuntimeTimelineFrame[];
};

export type MergedTimelineSelection = {
  timestamp: number;
  byRuntime: Map<string, RuntimeTimelineFrame | null>;
};

const normalizeFrame = (runtimeId: string, frame: RuntimeTimelineFrame): RuntimeTimelineFrame => ({
  runtimeId: String(runtimeId || frame.runtimeId || '').trim().toLowerCase(),
  height: Math.max(0, Math.floor(Number(frame.height || 0))),
  timestamp: Math.max(0, Math.floor(Number(frame.timestamp || 0))),
  stateHash: String(frame.stateHash || ''),
  materialized: frame.materialized === true,
  graphChanged: frame.graphChanged === true,
});

const compareFrames = (left: RuntimeTimelineFrame, right: RuntimeTimelineFrame): number =>
  left.timestamp - right.timestamp
  || left.runtimeId.localeCompare(right.runtimeId)
  || left.height - right.height;

export const compareRuntimeTimelineFrames = compareFrames;

export const normalizeRuntimeTimelineIndex = (index: RuntimeTimelineIndex): RuntimeTimelineIndex => {
  const runtimeId = String(index.runtimeId || '').trim().toLowerCase();
  const byHeight = new Map<number, RuntimeTimelineFrame>();
  for (const candidate of index.frames) {
    const frame = normalizeFrame(runtimeId, candidate);
    if (!frame.runtimeId || frame.height < 1 || frame.timestamp < 1) continue;
    byHeight.set(frame.height, frame);
  }
  return { runtimeId, frames: Array.from(byHeight.values()).sort(compareFrames) };
};

export const mergeRuntimeTimelineIndexes = (indexes: RuntimeTimelineIndex[]): MergedTimelineEvent[] => {
  return indexes
    .map(normalizeRuntimeTimelineIndex)
    .flatMap((index) => index.frames)
    .sort(compareFrames)
    .map((frame) => ({ timestamp: frame.timestamp, changed: [frame] }));
};

const floorFrame = (frames: RuntimeTimelineFrame[], timestamp: number): RuntimeTimelineFrame | null => {
  let low = 0;
  let high = frames.length - 1;
  let found: RuntimeTimelineFrame | null = null;
  while (low <= high) {
    const middle = Math.floor((low + high) / 2);
    const frame = frames[middle]!;
    if (frame.timestamp <= timestamp) {
      found = frame;
      low = middle + 1;
    } else {
      high = middle - 1;
    }
  }
  return found;
};

export const selectMergedTimelineAt = (
  indexes: RuntimeTimelineIndex[],
  timestamp: number,
): MergedTimelineSelection => {
  const target = Math.max(0, Math.floor(Number(timestamp || 0)));
  const normalized = indexes.map(normalizeRuntimeTimelineIndex)
    .sort((left, right) => left.runtimeId.localeCompare(right.runtimeId));
  return {
    timestamp: target,
    byRuntime: new Map(normalized.map((index) => [index.runtimeId, floorFrame(index.frames, target)])),
  };
};

const frameAtOrBeforeEvent = (
  frames: RuntimeTimelineFrame[],
  event: RuntimeTimelineFrame,
): RuntimeTimelineFrame | null => {
  let found: RuntimeTimelineFrame | null = null;
  for (const frame of frames) {
    if (compareFrames(frame, event) > 0) break;
    found = frame;
  }
  return found;
};

export const selectMergedTimelineEvent = (
  indexes: RuntimeTimelineIndex[],
  event: RuntimeTimelineFrame,
): MergedTimelineSelection => {
  const cursor = normalizeFrame(event.runtimeId, event);
  const normalized = indexes.map(normalizeRuntimeTimelineIndex)
    .sort((left, right) => left.runtimeId.localeCompare(right.runtimeId));
  return {
    timestamp: cursor.timestamp,
    byRuntime: new Map(normalized.map((index) => [index.runtimeId, frameAtOrBeforeEvent(index.frames, cursor)])),
  };
};

export const runtimeTimelineColor = (runtimeId: string): string => {
  const hash = Array.from(String(runtimeId || '').toLowerCase())
    .reduce((value, char) => Math.imul(value ^ char.charCodeAt(0), 16777619) >>> 0, 2166136261);
  const hue = hash % 360;
  return `hsl(${hue}, 72%, 62%)`;
};
