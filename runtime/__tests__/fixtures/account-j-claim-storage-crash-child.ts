import {
  createEmptyEnv,
  enqueueRuntimeInput,
  getFrameDb,
  getRuntimeStorageDb,
  process as processRuntime,
  tryOpenDb,
  tryOpenFrameDb,
} from '../../runtime';
import {
  deriveSignerAddressSync,
  deriveSignerKeySync,
  registerSignerKey,
} from '../../account/crypto';
import {
  accountStateDomainFromJurisdiction,
  computeAccountStateRoot,
} from '../../account/state-root';
import {
  applyAccountJClaimInsert,
  createAccountJClaimProof,
  createAccountJClaimRecord,
} from '../../account/j-claim-accumulator';
import {
  cacheCommittedAccountJClaimNodeChanges,
  getAccountJClaimNodeStore,
} from '../../account/j-claim-store';
import {
  buildEntityFrameAuthority,
  computeCanonicalEntityConsensusStateHash,
  computeEntityFrameAuthorityRoot,
} from '../../entity/consensus/state-root';
import { generateLazyEntityId } from '../../entity/factory';
import { handleOpenAccountEntityTx } from '../../entity/tx/handlers/open-account';
import { markStorageAccountDirty, markStorageEntityDirty } from '../../machine/env-events';
import {
  saveRuntimeFrameToStorage,
  type StoragePersistenceBoundary,
} from '../../storage';
import type { EntityReplica, JReplica, JurisdictionConfig } from '../../types';
import { getPerfMs } from '../../utils';
import { buildRuntimeCheckpointSnapshot } from '../../wal/snapshot';

const [seed, requestedBoundary] = Bun.argv.slice(2);
if (!seed || !requestedBoundary) throw new Error('account J crash seed and boundary are required');
if (![
  'before-authoritative-history-commit',
  'after-authoritative-history-commit',
  'after-current-cache-commit',
].includes(requestedBoundary)) {
  throw new Error(`ACCOUNT_J_CRASH_BOUNDARY_INVALID:${requestedBoundary}`);
}

const signerA = deriveSignerAddressSync(seed, '1').toLowerCase();
const signerB = deriveSignerAddressSync(seed, '2').toLowerCase();
registerSignerKey(seed, signerA, deriveSignerKeySync(seed, '1'));
registerSignerKey(seed, signerB, deriveSignerKeySync(seed, '2'));
const entityId = generateLazyEntityId([signerA], 1n).toLowerCase();
const counterpartyId = generateLazyEntityId([signerB], 1n).toLowerCase();
const jurisdiction: JurisdictionConfig = {
  name: 'account-j-claim-storage-crash',
  address: 'browservm://account-j-claim-storage-crash',
  chainId: 31_337,
  depositoryAddress: `0x${'31'.repeat(20)}`,
  entityProviderAddress: `0x${'32'.repeat(20)}`,
};

const env = createEmptyEnv(seed);
env.runtimeId = signerA;
env.dbNamespace = signerA;
env.quietRuntimeLogs = true;
env.activeJurisdiction = jurisdiction.name;
env.runtimeConfig = { ...env.runtimeConfig, storage: { enabled: false } };
const storageConfig = {
    snapshotPeriodFrames: 256,
    retainSnapshots: 3,
    epochMaxBytes: 1_000_000_000,
    frameDbMaxBytes: 1_000_000_000,
    frameDbRetainFrames: 100_000,
    materializePeriodFrames: 1,
    canonicalHashPeriodFrames: 1,
    accountMerkleRadix: 16,
};
env.jReplicas.set(jurisdiction.name, {
  ...jurisdiction,
  blockNumber: 0n,
  stateRoot: new Uint8Array(32),
  mempool: [],
  blockDelayMs: 0,
  lastBlockTimestamp: 0,
  rpcs: [jurisdiction.address!],
  position: { x: 0, y: 0, z: 0 },
  contracts: {
    depository: jurisdiction.depositoryAddress,
    entityProvider: jurisdiction.entityProviderAddress,
    account: '0x000000000000000000000000000000000000ac01',
    deltaTransformer: '0x000000000000000000000000000000000000de17',
  },
} as JReplica);

enqueueRuntimeInput(env, {
  runtimeTxs: [
    { entityId, signerId: signerA },
    { entityId: counterpartyId, signerId: signerB },
  ].map(({ entityId: targetEntityId, signerId }) => ({
    type: 'importReplica' as const,
    entityId: targetEntityId,
    signerId,
    data: {
      isProposer: true,
      config: {
        mode: 'proposer-based' as const,
        threshold: 1n,
        validators: [signerId],
        shares: { [signerId]: 1n },
        jurisdiction,
      },
    },
  })),
  entityInputs: [],
});
await processRuntime(env, []);

const replica = Array.from(env.eReplicas.values()).find((candidate) => candidate.entityId === entityId);
if (!replica) throw new Error('ACCOUNT_J_CRASH_REPLICA_MISSING');
const opened = handleOpenAccountEntityTx(env, replica.state, {
  type: 'openAccount',
  data: {
    targetEntityId: counterpartyId,
    accountDomain: accountStateDomainFromJurisdiction(jurisdiction),
    watchSeed: `0x${'33'.repeat(32)}`,
  },
});
replica.state = opened.newState;
env.runtimeConfig = { ...env.runtimeConfig, storage: { enabled: true, ...storageConfig } };

const refreshGenesisAnchor = (target: EntityReplica): void => {
  if (target.certifiedFrameAnchor?.height !== 0) return;
  const { runtimeCheckpoint: _priorRuntimeCheckpoint, ...genesis } = target.certifiedFrameAnchor;
  target.certifiedFrameAnchor = {
    ...genesis,
    stateRoot: computeCanonicalEntityConsensusStateHash(target.state),
    authorityRoot: computeEntityFrameAuthorityRoot(buildEntityFrameAuthority(target.state)),
  };
};

refreshGenesisAnchor(replica);
markStorageAccountDirty(env, entityId, counterpartyId);
markStorageEntityDirty(env, entityId);
await saveRuntimeFrameToStorage({
  env,
  tryOpenDb,
  getRuntimeDb: getRuntimeStorageDb,
  tryOpenFrameDb,
  getFrameDb,
  getPerfMs,
  formatPerfMs: (value) => value.toFixed(2),
});

const account = replica.state.accounts.get(counterpartyId);
if (!account) throw new Error('ACCOUNT_J_CRASH_ACCOUNT_MISSING');
const side = account.leftEntity === entityId ? 'left' as const : 'right' as const;
const state = side === 'left' ? account.leftPendingJClaims : account.rightPendingJClaims;
const record = createAccountJClaimRecord({
  chainId: jurisdiction.chainId,
  depositoryAddress: jurisdiction.depositoryAddress,
  leftEntity: account.leftEntity,
  rightEntity: account.rightEntity,
}, side, {
  jHeight: 7,
  jBlockHash: `0x${'41'.repeat(32)}`,
  eventsHash: `0x${'42'.repeat(32)}`,
});
const applied = applyAccountJClaimInsert(
  state,
  record,
  createAccountJClaimProof(getAccountJClaimNodeStore(env), state.root, record),
);
if (side === 'left') account.leftPendingJClaims = applied.state;
else account.rightPendingJClaims = applied.state;
cacheCommittedAccountJClaimNodeChanges(env, applied);
const accountRoot = computeAccountStateRoot(account);
account.currentFrame.accountStateRoot = accountRoot;
account.currentFrame.stateHash = accountRoot;
refreshGenesisAnchor(replica);
markStorageAccountDirty(env, entityId, counterpartyId);
markStorageEntityDirty(env, entityId);
env.height += 1;
env.timestamp += 1;

const checkpoint = buildRuntimeCheckpointSnapshot(env);
const checkpointState = checkpoint['runtimeState'] as { accountJClaimNodes?: Map<string, unknown> };
if (checkpointState.accountJClaimNodes?.size !== 1) {
  throw new Error(`ACCOUNT_J_CRASH_CHECKPOINT_NODE_COUNT:${checkpointState.accountJClaimNodes?.size ?? -1}`);
}

if (requestedBoundary === 'before-authoritative-history-commit') {
  process.kill(process.pid, 'SIGKILL');
  throw new Error('ACCOUNT_J_CRASH_SIGKILL_RETURNED');
}

await saveRuntimeFrameToStorage({
  env,
  tryOpenDb,
  getRuntimeDb: getRuntimeStorageDb,
  tryOpenFrameDb,
  getFrameDb,
  getPerfMs,
  formatPerfMs: (value) => value.toFixed(2),
  onPersistenceBoundary: (boundary: StoragePersistenceBoundary) => {
    if (boundary !== requestedBoundary) return;
    process.kill(process.pid, 'SIGKILL');
  },
});
throw new Error(`ACCOUNT_J_CRASH_BOUNDARY_NOT_REACHED:${requestedBoundary}`);
