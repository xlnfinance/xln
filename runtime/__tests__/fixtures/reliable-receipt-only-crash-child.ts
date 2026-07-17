import { deriveSignerAddressSync } from '../../account/crypto';
import { markLocalJAuthorityRuntimeTx } from '../../jurisdiction/registration-evidence';
import { registerReliableIngress } from '../../machine/reliable-delivery';
import {
  createEmptyEnv,
  enqueueRuntimeInput,
  process as processRuntime,
} from '../../runtime';
import type { DeliverableEntityInput } from '../../types';
import {
  buildCatchupFixtureCertificate,
  catchupFixtureDeliverable,
  createCatchupFixtureState,
  prepareCatchupFixtureReplica,
  registerCatchupFixtureSigners,
} from './reliable-local-catchup-fixture';

const [seed] = Bun.argv.slice(2);
if (!seed) throw new Error('reliable receipt-only crash seed is required');

const runtimeId = deriveSignerAddressSync(seed, '1').toLowerCase();
const peerRuntimeId = deriveSignerAddressSync(seed, 'peer').toLowerCase();
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
    materializePeriodFrames: 50,
    canonicalHashPeriodFrames: 1,
    accountMerkleRadix: 16,
  },
};

const initialState = createCatchupFixtureState(leaderSignerId, targetSignerId);
await prepareCatchupFixtureReplica(env, initialState, leaderSignerId, targetSignerId);
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

const certified = await buildCatchupFixtureCertificate(env, initialState, 100);
await processRuntime(env, [catchupFixtureDeliverable(
  runtimeId,
  initialState.entityId,
  targetSignerId,
  certified.frame,
)]);
const stalePrecommit: DeliverableEntityInput = {
  runtimeId,
  entityId: initialState.entityId,
  signerId: targetSignerId,
  hashPrecommitFrame: {
    height: certified.frame.height,
    frameHash: certified.frame.hash,
  },
  hashPrecommits: new Map([[
    leaderSignerId,
    certified.frame.collectedSigs.get(leaderSignerId)!,
  ]]),
};
if (registerReliableIngress(env, peerRuntimeId, stalePrecommit).kind !== 'enqueue') {
  throw new Error('RELIABLE_RECEIPT_ONLY_INGRESS_NOT_ENQUEUED');
}
await processRuntime(env, [stalePrecommit]);
if (env.height !== 3) throw new Error(`RELIABLE_RECEIPT_ONLY_RUNTIME_HEIGHT:${env.height}`);
if ((env.runtimeState?.pendingReliableIngress?.size ?? 0) !== 0) {
  throw new Error('RELIABLE_RECEIPT_ONLY_PENDING_NOT_CLEARED');
}
if (![...(env.runtimeState?.reliableIngressTerminalWatermarks?.values() ?? [])]
  .some(receipt => receipt.body.identity.kind === 'hash-precommit')) {
  throw new Error('RELIABLE_RECEIPT_ONLY_TERMINAL_MISSING');
}

process.kill(process.pid, 'SIGKILL');
throw new Error('RELIABLE_RECEIPT_ONLY_SIGKILL_RETURNED');
