import { deriveSignerAddressSync } from '../../account/crypto';
import {
  createEmptyEnv,
  enqueueRuntimeInput,
  getFrameDb,
  process as processRuntime,
} from '../../runtime';
import { readStorageFrameRecord } from '../../storage';
import {
  buildCatchupFixtureCertificate,
  catchupFixtureDeliverable,
  createCatchupFixtureState,
  prepareCatchupFixtureReplica,
  registerCatchupFixtureSigners,
} from './reliable-local-catchup-fixture';
import { markLocalJAuthorityRuntimeTx } from '../../jurisdiction/registration-evidence';

const [seed] = Bun.argv.slice(2);
if (!seed) throw new Error('reliable local catch-up crash seed is required');

const runtimeId = deriveSignerAddressSync(seed, '1').toLowerCase();
const env = createEmptyEnv(seed);
const { leaderSignerId, targetSignerId } = registerCatchupFixtureSigners(env, seed);
env.runtimeId = runtimeId;
env.dbNamespace = runtimeId;
env.scenarioMode = true;
env.quietRuntimeLogs = true;
env.runtimeConfig = {
  ...env.runtimeConfig,
  storage: {
    enabled: true,
    snapshotPeriodFrames: 50,
    retainSnapshots: 2,
    epochMaxBytes: 1_000_000_000,
    frameDbMaxBytes: 1_000_000_000,
    frameDbRetainFrames: 100,
    materializePeriodFrames: 1,
    canonicalHashPeriodFrames: 1,
    accountMerkleRadix: 16,
  },
};

const initialState = createCatchupFixtureState(leaderSignerId, targetSignerId);
await prepareCatchupFixtureReplica(
  env,
  initialState,
  leaderSignerId,
  targetSignerId,
);
const builder = createEmptyEnv(`${seed}:certificate-builder`);
builder.quietRuntimeLogs = true;
registerCatchupFixtureSigners(builder, seed);
const heightOne = await buildCatchupFixtureCertificate(builder, initialState, 100);
const heightTwo = await buildCatchupFixtureCertificate(builder, heightOne.nextState, 200);
const h1 = catchupFixtureDeliverable(runtimeId, initialState.entityId, targetSignerId, heightOne.frame);
const h2 = catchupFixtureDeliverable(runtimeId, initialState.entityId, targetSignerId, heightTwo.frame);

const observedBlockHash = `0x${'31'.repeat(32)}`;
enqueueRuntimeInput(env, {
  runtimeTxs: [markLocalJAuthorityRuntimeTx({
    type: 'observeJRange',
    data: {
      entityId: initialState.entityId,
      signerId: targetSignerId,
      jurisdictionRef: 'unconfigured',
      scannedThroughHeight: 1,
      tipBlockHash: observedBlockHash,
      headers: [{ jHeight: 1, jBlockHash: observedBlockHash }],
      blocks: [],
    },
  })],
  entityInputs: [],
});
await processRuntime(env, []);
if (env.height !== 1) throw new Error(`CATCHUP_CRASH_ANCHOR_HEIGHT:${env.height}`);

env.pendingNetworkOutputs = [structuredClone(h2)];
await processRuntime(env, []);
await processRuntime(env, []);
const beforeH1 = env.eReplicas.get(`${initialState.entityId}:${targetSignerId}`);
if (beforeH1?.state.height !== 0) {
  throw new Error(`CATCHUP_CRASH_H2_APPLIED_EARLY:${beforeH1?.state.height ?? 'missing'}`);
}

env.pendingNetworkOutputs = [structuredClone(h1), ...(env.pendingNetworkOutputs ?? [])];
await processRuntime(env, []);
await processRuntime(env, [structuredClone(h2)]);
const afterH1 = env.eReplicas.get(`${initialState.entityId}:${targetSignerId}`);
// Deferred H2 attempts mutate no certified state and therefore own no empty
// Runtime frames. The authority anchor is R1 and certified H1 is published
// atomically in R2 while H2 remains in both durable retry queues.
if (env.height !== 2 || afterH1?.state.height !== 1) {
  throw new Error(`CATCHUP_CRASH_H1_NOT_DURABLE:R=${env.height}:E=${afterH1?.state.height ?? 'missing'}`);
}
const durableFrame = await readStorageFrameRecord(getFrameDb(env), env.height);
const durableHeights = durableFrame?.runtimeInput.entityInputs
  .map(input => input.proposedFrame?.height ?? null);
if (durableHeights?.length !== 1 || durableHeights[0] !== 1) {
  throw new Error(`CATCHUP_CRASH_FRAME_BARRIER:${String(durableHeights)}`);
}
const durablePendingHeights = durableFrame?.pendingRuntimeInput?.entityInputs
  .map(input => input.proposedFrame?.height ?? null);
if (durablePendingHeights?.length !== 1 || durablePendingHeights[0] !== 2) {
  throw new Error(`CATCHUP_CRASH_PENDING_INPUT_FENCE:${String(durablePendingHeights)}`);
}
if (env.pendingNetworkOutputs?.length !== 1 || env.pendingNetworkOutputs[0]?.proposedFrame?.height !== 2) {
  throw new Error('CATCHUP_CRASH_H2_OUTBOX_NOT_DURABLE');
}
if (env.runtimeMempool?.entityInputs.length !== 1 || env.runtimeMempool.entityInputs[0]?.proposedFrame?.height !== 2) {
  throw new Error('CATCHUP_CRASH_H2_MEMPOOL_NOT_DURABLE');
}

process.kill(process.pid, 'SIGKILL');
throw new Error('SIGKILL did not stop reliable local catch-up child');
