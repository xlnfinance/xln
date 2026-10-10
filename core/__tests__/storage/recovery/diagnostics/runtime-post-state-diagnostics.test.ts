import { expect, test } from 'bun:test';
import { applyRuntimeInput, createEmptyEnv } from '../../../../runtime';
import { verifyRecoveryJournalFrame } from '../../../../storage/recovery/journal/verification';
import { buildStorageLiveReplicaMetaCommitment } from '../../../../storage/replica/replicas';
import { computeRuntimePostStateComponentDigests, computeStoragePostStateHash } from '../../../../storage/hashes';
import { buildReplayVerifiableRuntimePostStateView, buildStorageRuntimeMachineSnapshot } from '../../../../storage/wal/snapshot';
import { prepareRuntimeOutputRows } from '../../../../storage/wal/outbox-payload';
import type { PersistedFrameJournal } from '../../../../storage/types';
import type { EntityInfraContext } from '../../../../types/entity/infra-context';
import { assertRecoveryRuntimeMachineMatches } from '../../../../storage/recovery/machine';

const SEED_SENTINEL = 'recovery-diagnostic-private-seed-sentinel';
const KEY_SENTINEL = `0x${'ad'.repeat(32)}`;
const CORRUPTED_HASH = `0x${'99'.repeat(32)}`;

const prepareFrame = async (includeSecrets = true) => {
  const env = createEmptyEnv(SEED_SENTINEL);
  env.scenarioMode = true;
  env.state.height = 2;
  env.state.timestamp = 1234;
  const result = await applyRuntimeInput(env, { runtimeTxs: [], entityInputs: [] });
  if (!env.infrastructure) throw new Error('TEST_INFRASTRUCTURE_MISSING');
  if (includeSecrets) env.infrastructure.entityEncryptionSeeds = new Map([[`0x${'11'.repeat(32)}`, KEY_SENTINEL]]);
  const replicaMetaDigest = buildStorageLiveReplicaMetaCommitment(env).digest;
  const runtimeComponentDigests = computeRuntimePostStateComponentDigests(buildReplayVerifiableRuntimePostStateView(env));
  const outbox = prepareRuntimeOutputRows(2, result.entityOutbox).commitment;
  const coordinates = { height: 2, timestamp: env.state.timestamp, replicaMetaDigest,
    runtimeOutputCount: outbox.count, runtimeOutputsDigest: outbox.digest };
  const actualHash = computeStoragePostStateHash({ ...coordinates, runtimeComponentDigests });
  const frame: PersistedFrameJournal = {
    ...coordinates, postStateHash: CORRUPTED_HASH, materializedState: false,
    runtimeInput: result.appliedRuntimeInput, entityContexts: result.entityContexts,
    runtimeOutputs: result.entityOutbox, logs: [],
  };
  return { env, frame, result, actualHash, runtimeComponentDigests };
};

const readMismatch = (fixture: Awaited<ReturnType<typeof prepareFrame>>): { message: string; diagnostic: Record<string, unknown> } => {
  let failure: unknown;
  try { verifyRecoveryJournalFrame(fixture.env, fixture.frame, 2, fixture.result); }
  catch (error) { failure = error; }
  expect(failure).toBeInstanceOf(Error);
  if (!(failure instanceof Error)) throw new Error('TEST_MISMATCH_REQUIRED');
  expect(failure.message).toStartWith(
    `RECOVERY_JOURNAL_POST_STATE_HASH_MISMATCH:height=2:expected=${CORRUPTED_HASH}:actual=${fixture.actualHash}`,
  );
  expect(failure.message).not.toContain(SEED_SENTINEL);
  expect(failure.message).not.toContain(KEY_SENTINEL);
  const marker = ':diagnostics=';
  const start = failure.message.indexOf(marker);
  expect(start).toBeGreaterThan(0);
  return { message: failure.message, diagnostic: JSON.parse(failure.message.slice(start + marker.length)) };
};

test('h2 mismatch preserves rejection hashes and emits only safe component evidence without a snapshot', async () => {
  const fixture = await prepareFrame();
  fixture.frame.timestamp += 7;
  const { diagnostic } = readMismatch(fixture);
  expect(diagnostic).toEqual({
    height: 2, frameTimestamp: 1241, replayTimestamp: 1234, runtimeTxTypes: [],
    replicaMetaDigest: fixture.frame.replicaMetaDigest,
    runtimeOutputCount: fixture.frame.runtimeOutputCount,
    runtimeOutputsDigest: fixture.frame.runtimeOutputsDigest,
    hasRecordedMachine: false, actualComponents: fixture.runtimeComponentDigests,
    recordedSnapshotComponents: null, componentMismatches: null,
  });
});

test('h2 mismatch compares recorded component digests without leaking persisted encryption keys', async () => {
  const fixture = await prepareFrame();
  fixture.frame.runtimeMachine = buildStorageRuntimeMachineSnapshot(fixture.env);
  const { diagnostic } = readMismatch(fixture);
  expect(diagnostic['hasRecordedMachine']).toBe(true);
  expect(diagnostic['recordedSnapshotComponents']).toEqual(fixture.runtimeComponentDigests);
  expect(diagnostic['componentMismatches']).toEqual([]);
});

test('empty snapshot infrastructure is named as diagnostic evidence and never becomes an acceptance oracle', async () => {
  const fixture = await prepareFrame(false);
  fixture.frame.runtimeMachine = buildStorageRuntimeMachineSnapshot(fixture.env);
  const { diagnostic } = readMismatch(fixture);
  expect(diagnostic['componentMismatches']).toEqual(['infrastructure']);
  fixture.frame.postStateHash = fixture.actualHash;
  expect(() => verifyRecoveryJournalFrame(fixture.env, fixture.frame, 2, fixture.result)).not.toThrow();
});

const PAYLOAD_SENTINEL = 'recovery-diagnostic-payload-sentinel';

const captureMessage = (run: () => void): string => {
  try { run(); } catch (error) { return String((error as Error).message); }
  throw new Error('TEST_MISMATCH_REQUIRED');
};

test('an entity-context mismatch reports digests and the first differing key, never the contexts', async () => {
  // The message embedded every replayed context (gossip profiles, HTLC pages).
  const fixture = await prepareFrame();
  const context = {
    version: 1, proposerReplicaId: `${PAYLOAD_SENTINEL}:a`, entityId: PAYLOAD_SENTINEL,
    proposerSignerId: PAYLOAD_SENTINEL, parentFrameHash: CORRUPTED_HASH, height: 2,
    gossipProfiles: [], peerAssertions: [], htlc: { version: 1, entries: [] },
  } as unknown as EntityInfraContext;
  fixture.result.entityContexts = new Map([[`${PAYLOAD_SENTINEL}:a:2`, context]]);
  const message = captureMessage(() => verifyRecoveryJournalFrame(fixture.env, fixture.frame, 2, fixture.result));
  expect(message).toStartWith('RECOVERY_JOURNAL_ENTITY_CONTEXTS_MISMATCH:height=2:');
  expect(message).toContain(`expectedCount=0:actualCount=1:firstDifferentKey=${PAYLOAD_SENTINEL}:a:2`);
  expect(message.split(PAYLOAD_SENTINEL)).toHaveLength(2);
});

test('a replica-meta mismatch reports input counts, never applied WAL inputs or the outbox', async () => {
  const fixture = await prepareFrame();
  fixture.frame.replicaMetaDigest = CORRUPTED_HASH;
  fixture.result.appliedRuntimeInput = {
    runtimeTxs: [], entityInputs: [{ entityId: PAYLOAD_SENTINEL, signerId: PAYLOAD_SENTINEL, entityTxs: [] }],
  } as unknown as typeof fixture.result.appliedRuntimeInput;
  fixture.result.entityOutbox = [{ runtimeId: PAYLOAD_SENTINEL, entityId: PAYLOAD_SENTINEL, entityTxs: [] }];
  const message = captureMessage(() => verifyRecoveryJournalFrame(fixture.env, fixture.frame, 2, fixture.result));
  expect(message).toStartWith(`RECOVERY_JOURNAL_REPLICA_META_DIGEST_MISMATCH:height=2:expected=${CORRUPTED_HASH}`);
  expect(message).toContain('"appliedEntityInputCount":1');
  expect(message).toContain('"entityOutboxCount":1');
  expect(message).not.toContain(PAYLOAD_SENTINEL);
});

test('a runtime-machine mismatch names the field without leaking its secret value', () => {
  // The mismatch detail embedded raw field values, and machine fields include
  // entity encryption seeds; the message reaches logs and incident journals.
  const env = createEmptyEnv(SEED_SENTINEL);
  if (!env.infrastructure) throw new Error('TEST_INFRASTRUCTURE_MISSING');
  const entityId = `0x${'11'.repeat(32)}`;
  const recordedSeed = `0x${'ad'.repeat(64)}`;
  const liveSeed = `0x${'be'.repeat(64)}`;
  env.infrastructure.entityEncryptionSeeds = new Map([[entityId, recordedSeed]]);
  const recorded = buildStorageRuntimeMachineSnapshot(env);
  env.infrastructure.entityEncryptionSeeds = new Map([[entityId, liveSeed]]);

  let message = '';
  try {
    assertRecoveryRuntimeMachineMatches(env, recorded, 7);
  } catch (error) {
    message = String((error as Error).message);
  }
  expect(message).toContain('RECOVERY_JOURNAL_RUNTIME_MACHINE_MISMATCH:height=7');
  expect(message).toContain('entityEncryptionSeeds');
  expect(message).not.toContain('ad'.repeat(64));
  expect(message).not.toContain('be'.repeat(64));
});
