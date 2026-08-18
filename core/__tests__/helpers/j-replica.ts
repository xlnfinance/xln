import type { JReplica } from '../../types/jurisdiction-runtime';

type CanonicalJReplicaFixtureField =
  | 'blockNumber'
  | 'stateRoot'
  | 'mempool'
  | 'blockDelayMs'
  | 'lastBlockTimestamp'
  | 'position';
type TestJReplicaOverrides =
  & Pick<JReplica, 'name'>
  & Partial<Omit<JReplica, 'name' | CanonicalJReplicaFixtureField>>;

/** Build a complete persisted JReplica while keeping each test's domain fields explicit. */
export const createTestJReplica = (overrides: TestJReplicaOverrides): JReplica => ({
  blockNumber: 0n,
  stateRoot: null,
  mempool: [],
  blockDelayMs: 0,
  lastBlockTimestamp: 0,
  position: { x: 0, y: 0, z: 0 },
  ...overrides,
});
