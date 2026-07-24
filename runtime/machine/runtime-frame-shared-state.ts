export type RuntimeFrameSharedStateSnapshot = {
  present: boolean;
  value: unknown;
};

export type RuntimeFrameSharedStateGroup = {
  name: string;
  keys: readonly string[];
};

export const RUNTIME_FRAME_DB_HANDLE_GROUPS: readonly RuntimeFrameSharedStateGroup[] = [
  { name: 'storage-current', keys: ['storageDb', 'storageDbOpenPromise'] },
  { name: 'storage-previous', keys: ['storagePreviousDb', 'storagePreviousDbOpenPromise'] },
  { name: 'frames', keys: ['frameDb', 'frameDbOpenPromise'] },
  { name: 'infra', keys: ['infraDb', 'infraDbOpenPromise'] },
] as const;

const snapshotField = (
  state: Record<string, unknown>,
  key: string,
): RuntimeFrameSharedStateSnapshot => ({
  present: Object.prototype.hasOwnProperty.call(state, key),
  value: state[key],
});

const snapshotsEqual = (
  left: RuntimeFrameSharedStateSnapshot,
  right: RuntimeFrameSharedStateSnapshot,
): boolean => left.present === right.present && Object.is(left.value, right.value);

const groupMatches = (
  left: Map<string, RuntimeFrameSharedStateSnapshot>,
  right: Map<string, RuntimeFrameSharedStateSnapshot>,
  keys: readonly string[],
): boolean => keys.every((key) =>
  snapshotsEqual(
    left.get(key) ?? { present: false, value: undefined },
    right.get(key) ?? { present: false, value: undefined },
  ));

const snapshotGroup = (
  state: Record<string, unknown>,
  keys: readonly string[],
): Map<string, RuntimeFrameSharedStateSnapshot> =>
  new Map(keys.map((key) => [key, snapshotField(state, key)]));

const selectChangedGroup = (
  baseline: Map<string, RuntimeFrameSharedStateSnapshot>,
  liveState: Record<string, unknown>,
  workingState: Record<string, unknown>,
  group: RuntimeFrameSharedStateGroup,
): Map<string, RuntimeFrameSharedStateSnapshot> => {
  const live = snapshotGroup(liveState, group.keys);
  const working = snapshotGroup(workingState, group.keys);
  const liveChanged = !groupMatches(live, baseline, group.keys);
  const workingChanged = !groupMatches(working, baseline, group.keys);
  if (workingChanged && liveChanged && !groupMatches(live, working, group.keys)) {
    throw new Error(`RUNTIME_FRAME_SHARED_STATE_CONFLICT:${group.name}`);
  }
  return workingChanged ? working : live;
};

const selectChangedField = (
  baseline: RuntimeFrameSharedStateSnapshot,
  live: RuntimeFrameSharedStateSnapshot,
  working: RuntimeFrameSharedStateSnapshot,
  key: string,
): RuntimeFrameSharedStateSnapshot => {
  const liveChanged = !snapshotsEqual(live, baseline);
  const workingChanged = !snapshotsEqual(working, baseline);
  if (workingChanged && liveChanged && !snapshotsEqual(live, working)) {
    throw new Error(`RUNTIME_FRAME_SHARED_STATE_CONFLICT:${key}`);
  }
  return workingChanged ? working : live;
};

export const reconcileRuntimeFrameSharedState = (
  baseline: Map<string, RuntimeFrameSharedStateSnapshot>,
  liveState: Record<string, unknown>,
  workingState: Record<string, unknown>,
  sharedKeys: ReadonlySet<string>,
  groups: readonly RuntimeFrameSharedStateGroup[] = RUNTIME_FRAME_DB_HANDLE_GROUPS,
): Map<string, RuntimeFrameSharedStateSnapshot> => {
  const selected = new Map<string, RuntimeFrameSharedStateSnapshot>();
  const groupedKeys = new Set<string>();

  for (const group of groups) {
    for (const key of group.keys) {
      if (!sharedKeys.has(key)) throw new Error(`RUNTIME_FRAME_SHARED_STATE_GROUP_UNKNOWN:${group.name}:${key}`);
      if (groupedKeys.has(key)) throw new Error(`RUNTIME_FRAME_SHARED_STATE_GROUP_DUPLICATE:${group.name}:${key}`);
      groupedKeys.add(key);
    }
    const source = selectChangedGroup(baseline, liveState, workingState, group);
    for (const key of group.keys) selected.set(key, source.get(key)!);
  }

  for (const key of sharedKeys) {
    if (groupedKeys.has(key)) continue;
    const base = baseline.get(key) ?? { present: false, value: undefined };
    const live = snapshotField(liveState, key);
    const working = snapshotField(workingState, key);
    selected.set(key, selectChangedField(base, live, working, key));
  }

  return selected;
};

const assertHandleGroup = (
  state: Record<string, unknown>,
  group: RuntimeFrameSharedStateGroup,
): void => {
  const [handleKey, promiseKey] = group.keys;
  if (!handleKey || !promiseKey) throw new Error(`RUNTIME_FRAME_STORAGE_GROUP_INVALID:${group.name}`);
  const handle = state[handleKey];
  const openPromise = state[promiseKey];
  if ((handle === null || handle === undefined) && openPromise !== null && openPromise !== undefined) {
    throw new Error(`RUNTIME_FRAME_STORAGE_HANDLE_PAIR_INVALID:${group.name}:promise_without_handle`);
  }
  const status = handle && typeof handle === 'object'
    ? String((handle as { status?: unknown }).status ?? '')
    : '';
  if (status === 'closing' || status === 'closed') {
    throw new Error(`RUNTIME_FRAME_STORAGE_HANDLE_STATUS_INVALID:${group.name}:${status}`);
  }
};

export const assertRuntimeFrameStorageState = (state: Record<string, unknown>): void => {
  for (const group of RUNTIME_FRAME_DB_HANDLE_GROUPS) assertHandleGroup(state, group);
  const current = state['storageDb'];
  const previous = state['storagePreviousDb'];
  if (current !== null && current !== undefined && Object.is(current, previous)) {
    throw new Error('RUNTIME_FRAME_STORAGE_HANDLE_ALIAS:storage-current:storage-previous');
  }
};
