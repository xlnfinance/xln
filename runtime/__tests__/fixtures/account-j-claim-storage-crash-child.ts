import {
  applyRuntimeInput,
  createEmptyEnv,
  enqueueRuntimeInput,
  getFrameDb,
  getRuntimeStorageDb,
  process as processRuntime,
  tryOpenDb,
  tryOpenFrameDb,
} from '../../runtime';
import { applyAccountInput } from '../../account/consensus';
import { proposeAccountFrame } from '../../account/consensus/propose';
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
env.scenarioMode = true;
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
    canonicalHashPeriodFrames: 0,
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
const counterpartyReplica = Array.from(env.eReplicas.values()).find((candidate) => (
  candidate.entityId === counterpartyId
));
if (!counterpartyReplica) throw new Error('ACCOUNT_J_CRASH_COUNTERPARTY_REPLICA_MISSING');
const counterpartyOpened = handleOpenAccountEntityTx(env, counterpartyReplica.state, {
  type: 'openAccount',
  data: {
    targetEntityId: entityId,
    accountDomain: accountStateDomainFromJurisdiction(jurisdiction),
    watchSeed: `0x${'33'.repeat(32)}`,
  },
});
counterpartyReplica.state = counterpartyOpened.newState;
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
refreshGenesisAnchor(counterpartyReplica);
const account = replica.state.accounts.get(counterpartyId);
if (!account) throw new Error('ACCOUNT_J_CRASH_ACCOUNT_MISSING');
const counterpartyAccount = counterpartyReplica.state.accounts.get(entityId);
if (!counterpartyAccount) throw new Error('ACCOUNT_J_CRASH_COUNTERPARTY_ACCOUNT_MISSING');
account.mempool = [{
  type: 'j_event_claim',
  data: {
    jHeight: 7,
    jBlockHash: `0x${'41'.repeat(32)}`,
    events: [{
      type: 'AccountSettled',
      data: {
        leftEntity: account.leftEntity,
        rightEntity: account.rightEntity,
        tokenId: 1,
        leftReserve: '0',
        rightReserve: '0',
        collateral: '0',
        ondelta: '0',
        nonce: 1,
      },
    }],
  },
}];
const proposed = await proposeAccountFrame(
  env,
  account,
  env.timestamp,
  7,
  getAccountJClaimNodeStore(env),
);
if (!proposed.success || !proposed.accountInput) {
  throw new Error(`ACCOUNT_J_CRASH_PROPOSAL_FAILED:${proposed.error ?? 'unknown'}`);
}
account.pendingAccountInput = proposed.accountInput;
account.pendingAccountInputSignerId = signerB;
const peerValidation = await applyAccountInput(
  env,
  structuredClone(counterpartyAccount),
  proposed.accountInput,
  { entityTimestamp: env.timestamp, finalizedJHeight: 7 },
  new Map(),
);
if (!peerValidation.success || !peerValidation.response) {
  throw new Error(`ACCOUNT_J_CRASH_ACK_FAILED:${peerValidation.error ?? 'missing-response'}`);
}
const claimAck = peerValidation.response;
markStorageAccountDirty(env, entityId, counterpartyId);
markStorageAccountDirty(env, counterpartyId, entityId);
markStorageEntityDirty(env, entityId);
markStorageEntityDirty(env, counterpartyId);
await saveRuntimeFrameToStorage({
  env,
  tryOpenDb,
  getRuntimeDb: getRuntimeStorageDb,
  tryOpenFrameDb,
  getFrameDb,
  getPerfMs,
  formatPerfMs: (value) => value.toFixed(2),
});

env.timestamp += 1;
const runtimeInput = {
  runtimeTxs: [],
  entityInputs: [{
    entityId,
    signerId: signerA,
    entityTxs: [{ type: 'accountInput' as const, data: claimAck }],
  }],
};
const appliedRuntime = await applyRuntimeInput(env, runtimeInput);
const committedReplica = Array.from(env.eReplicas.values()).find((candidate) => candidate.entityId === entityId);
const committedAccount = committedReplica?.state.accounts.get(counterpartyId);
if (!committedAccount) throw new Error('ACCOUNT_J_CRASH_COMMITTED_ACCOUNT_MISSING');
const side = committedAccount.leftEntity === entityId ? 'left' as const : 'right' as const;
const state = side === 'left' ? committedAccount.leftPendingJClaims : committedAccount.rightPendingJClaims;
if (state.count !== 1n) {
  throw new Error(`ACCOUNT_J_CRASH_CLAIM_NOT_APPLIED:${state.count}:` + JSON.stringify({
    appliedInputs: appliedRuntime.appliedRuntimeInput.entityInputs.map(input => ({
      txs: input.entityTxs?.map(tx => tx.type),
      proposal: input.proposedFrame?.height ?? null,
    })),
    entityHeight: committedReplica?.state.height,
    mempool: committedReplica?.mempool.map(tx => tx.type),
    pendingFrame: committedAccount.pendingFrame?.height ?? null,
  }));
}

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
  currentFrameInput: appliedRuntime.appliedRuntimeInput,
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
