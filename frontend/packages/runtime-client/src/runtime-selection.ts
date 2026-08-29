export type RuntimeSelectionLease = Readonly<{
  revision: number;
  token: symbol;
}>;

export type RuntimeSelectionCoordinator = Readonly<{
  runLatest: <T>(operation: (lease: RuntimeSelectionLease) => Promise<T>) => Promise<T | null>;
  isCurrent: (lease: RuntimeSelectionLease) => boolean;
  assertActive: (lease: RuntimeSelectionLease) => void;
}>;

type RuntimeSelectionState = {
  revision: number;
  queue: Promise<void>;
  activeLease: RuntimeSelectionLease | null;
};

const createLease = (state: RuntimeSelectionState): RuntimeSelectionLease =>
  Object.freeze({
    revision: ++state.revision,
    token: Symbol('runtime-selection'),
  });

const queueSelection = (
  state: RuntimeSelectionState,
): Readonly<{ previous: Promise<void>; release: () => void }> => {
  const previous = state.queue;
  let release!: () => void;
  state.queue = new Promise<void>((resolve) => { release = resolve; });
  return { previous, release };
};

const leaseIsCurrent = (
  state: RuntimeSelectionState,
  lease: RuntimeSelectionLease,
): boolean => state.activeLease === lease && lease.revision === state.revision;

const assertActiveLease = (
  state: RuntimeSelectionState,
  lease: RuntimeSelectionLease,
): void => {
  if (state.activeLease !== lease) throw new Error('RUNTIME_SELECTION_LEASE_INVALID');
};

const runLatestSelection = async <T>(
  state: RuntimeSelectionState,
  operation: (lease: RuntimeSelectionLease) => Promise<T>,
): Promise<T | null> => {
  const lease = createLease(state);
  const { previous, release } = queueSelection(state);
  await previous;
  try {
    if (lease.revision !== state.revision) return null;
    state.activeLease = lease;
    const result = await operation(lease);
    return leaseIsCurrent(state, lease) ? result : null;
  } finally {
    if (state.activeLease === lease) state.activeLease = null;
    release();
  }
};

export const createRuntimeSelectionCoordinator = (): RuntimeSelectionCoordinator => {
  const state: RuntimeSelectionState = {
    revision: 0,
    queue: Promise.resolve(),
    activeLease: null,
  };
  return Object.freeze({
    runLatest: <T>(operation: (lease: RuntimeSelectionLease) => Promise<T>) =>
      runLatestSelection(state, operation),
    isCurrent: (lease: RuntimeSelectionLease) => leaseIsCurrent(state, lease),
    assertActive: (lease: RuntimeSelectionLease) => { assertActiveLease(state, lease); },
  });
};
