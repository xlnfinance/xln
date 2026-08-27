import {
  applyRuntimeInput,
  createEmptyEnv,
  enqueueRuntimeInput,
  getRuntimeWalDb,
  getHistoryViewDb,
  getRuntimeStorageDb,
  processRuntime,
  tryOpenStorageDb,
  tryOpenRuntimeWalDb,
  tryOpenHistoryViewDb,
} from '../../../runtime';
import { applyAccountInput } from '../../../account/consensus';
import { proposeAccountFrame } from '../../../account/consensus/proposal/propose';
import { createAccountConsensusContext } from '../../../entity/account/account-consensus-context';
import {
  deriveSignerAddressSync,
  deriveSignerKeySync,
  registerSignerKey,
} from '../../../account/crypto';
import {
  accountStateDomainFromJurisdiction,
  computeAccountStateRoot,
} from '../../../account/commitment/state-root';
import { safeStringify } from '../../../protocol/serialization';
import {
  getAccountJClaimNodeStore,
} from '../../../entity/account/account-j-claim-node-store';
import {
  buildEntityFrameAuthority,
  computeCanonicalEntityConsensusStateHash,
  computeEntityFrameAuthorityRoot,
} from '../../../entity/consensus/state-root';
import {
  commitEntityFrameCandidateState,
  createEntityFrameCandidateState,
} from '../../../entity/state-clone';
import { getEntityAccountForWrite } from '../../../entity/state/persistent-account-map';
import { generateLazyEntityId } from '../../../entity/factory';
import { handleOpenAccountEntityTx } from '../../../entity/tx/handlers/account/lifecycle/open-account';
import { applyRuntimeStorageChanges } from '../../../runtime/observability/env-events';
import {
  saveRuntimeFrameToStorage,
  type StoragePersistenceBoundary,
} from '../../../storage';
import type { EntityReplica, JurisdictionConfig } from '../../../entity/types';
import type { JReplica } from '../../../types/jurisdiction-runtime';
import { getPerfMs } from '../../../support/time';
import { buildRuntimeCheckpointSnapshot } from '../../../storage/wal/snapshot';
import { attachAccountDraftHankosAsEntity } from '../../../qa/account/draft';
import { forkAccountReplicaShell } from '../../../account/state/account-replica-shell';
import { createTestEntityImportRuntimeTx } from '../../../qa/entity-creation-fixture';
import {
  accountInputFailureMessage,
  isProposedAccountFrame,
  proposeAccountFrameMessage,
} from '../../../account/consensus/result';

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
    historyViewMaxBytes: 1_000_000_000,
    historyViewRetainFrames: 100_000,
    materializePeriodFrames: 1,
    canonicalHashPeriodFrames: 0,
    accountMerkleRadix: 16,
};
env.state.jReplicas.set(jurisdiction.name, {
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
  ].map(({ entityId: targetEntityId, signerId }) => createTestEntityImportRuntimeTx(env, {
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

const replica = Array.from(env.state.eReplicas.values()).find((candidate) => candidate.entityId === entityId);
if (!replica) throw new Error('ACCOUNT_J_CRASH_REPLICA_MISSING');
const opened = await handleOpenAccountEntityTx(replica.state, {
  type: 'openAccount',
  data: {
    targetEntityId: counterpartyId,
    accountDomain: accountStateDomainFromJurisdiction(jurisdiction),
    disputeConfig: { leftResponseSeconds: 10, rightResponseSeconds: 10 },
    watchSeed: `0x${'33'.repeat(32)}`,
  },
}, createAccountConsensusContext(env));
replica.state = commitEntityFrameCandidateState(opened.newState);
const counterpartyReplica = Array.from(env.state.eReplicas.values()).find((candidate) => (
  candidate.entityId === counterpartyId
));
if (!counterpartyReplica) throw new Error('ACCOUNT_J_CRASH_COUNTERPARTY_REPLICA_MISSING');
const counterpartyOpened = await handleOpenAccountEntityTx(counterpartyReplica.state, {
  type: 'openAccount',
  data: {
    targetEntityId: entityId,
    accountDomain: accountStateDomainFromJurisdiction(jurisdiction),
    disputeConfig: { leftResponseSeconds: 10, rightResponseSeconds: 10 },
    watchSeed: `0x${'33'.repeat(32)}`,
  },
}, createAccountConsensusContext(env));
counterpartyReplica.state = commitEntityFrameCandidateState(counterpartyOpened.newState);
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
replica.state = createEntityFrameCandidateState(replica.state);
counterpartyReplica.state = createEntityFrameCandidateState(counterpartyReplica.state);
const account = getEntityAccountForWrite(replica.state.accounts, counterpartyId);
if (!account) throw new Error('ACCOUNT_J_CRASH_ACCOUNT_MISSING');
const counterpartyAccount = getEntityAccountForWrite(counterpartyReplica.state.accounts, entityId);
if (!counterpartyAccount) throw new Error('ACCOUNT_J_CRASH_COUNTERPARTY_ACCOUNT_MISSING');
account.mempool = [{
  type: 'j_event_claim',
  data: {
    jHeight: 7,
    jBlockHash: `0x${'41'.repeat(32)}`,
    events: [{
      type: 'AccountSettled',
      data: {
        leftEntity: account.state.leftEntity,
        rightEntity: account.state.rightEntity,
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
  createAccountConsensusContext(env),
  account,
  env.state.timestamp,
  7,
);
if (!isProposedAccountFrame(proposed)) {
  throw new Error(`ACCOUNT_J_CRASH_PROPOSAL_FAILED:${proposeAccountFrameMessage(proposed) ?? 'unknown'}`);
}
const hankoAttachedProposal = await attachAccountDraftHankosAsEntity(env, entityId, signerA, proposed);
account.pendingAccountInput = hankoAttachedProposal;
if (hankoAttachedProposal.kind !== 'frame') throw new Error('ACCOUNT_J_CRASH_FRAME_PROPOSAL_REQUIRED');
account.currentFrameHanko = hankoAttachedProposal.proposal.frameHanko;
account.currentDisputeProofHanko = hankoAttachedProposal.proposal.disputeHanko?.hanko;
const peerValidation = await applyAccountInput(
  createAccountConsensusContext(env, new Map()),
  forkAccountReplicaShell(counterpartyAccount),
  hankoAttachedProposal,
  { entityTimestamp: env.state.timestamp, finalizedJHeight: 7 },
);
if (!peerValidation.ok || !peerValidation.response) {
  throw new Error(`ACCOUNT_J_CRASH_ACK_FAILED:${accountInputFailureMessage(peerValidation) ?? 'missing-response'}`);
}
const claimAck = await attachAccountDraftHankosAsEntity(
  env,
  counterpartyId,
  signerB,
  {
    accountInput: peerValidation.response,
    hashesToSign: peerValidation.hashesToSign,
  },
);
replica.state = commitEntityFrameCandidateState(replica.state);
counterpartyReplica.state = commitEntityFrameCandidateState(counterpartyReplica.state);
applyRuntimeStorageChanges(env, [
  { family: 'account', entityId, counterpartyId },
  { family: 'account', entityId: counterpartyId, counterpartyId: entityId },
  { family: 'entity', entityId },
  { family: 'entity', entityId: counterpartyId },
]);
await saveRuntimeFrameToStorage({
  entityContexts: new Map(),
  env,
  tryOpenDb: tryOpenStorageDb,
  getRuntimeDb: getRuntimeStorageDb,
  tryOpenRuntimeWalDb,
  getRuntimeWalDb,
  tryOpenHistoryViewDb,
  getHistoryViewDb,
  getPerfMs,
  formatPerfMs: (value) => value.toFixed(2),
});

env.state.timestamp += 1;
const runtimeInput = {
  runtimeTxs: [],
  entityInputs: [{
    entityId,
    signerId: signerA,
    entityTxs: [{ type: 'accountInput' as const, data: claimAck }],
  }],
};
const appliedRuntime = await applyRuntimeInput(env, runtimeInput);
const committedReplica = Array.from(env.state.eReplicas.values()).find((candidate) => candidate.entityId === entityId);
const committedAccount = committedReplica?.state.accounts.get(counterpartyId);
if (!committedAccount) throw new Error('ACCOUNT_J_CRASH_COMMITTED_ACCOUNT_MISSING');
const side = committedAccount.state.leftEntity === entityId ? 'left' as const : 'right' as const;
const state = side === 'left' ? committedAccount.state.leftPendingJClaims : committedAccount.state.rightPendingJClaims;
if (state.count !== 1n) {
  throw new Error(`ACCOUNT_J_CRASH_CLAIM_NOT_APPLIED:${state.count}:` + safeStringify({
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
const checkpointState = checkpoint['infrastructure'] as { accountJClaimNodes?: Map<string, unknown> };
if (checkpointState.accountJClaimNodes?.size !== 1) {
  throw new Error(`ACCOUNT_J_CRASH_CHECKPOINT_NODE_COUNT:${checkpointState.accountJClaimNodes?.size ?? -1}`);
}

if (requestedBoundary === 'before-authoritative-history-commit') {
  process.kill(process.pid, 'SIGKILL');
  throw new Error('ACCOUNT_J_CRASH_SIGKILL_RETURNED');
}

await saveRuntimeFrameToStorage({
  entityContexts: new Map(),
  env,
  currentFrameInput: appliedRuntime.appliedRuntimeInput,
  tryOpenDb: tryOpenStorageDb,
  getRuntimeDb: getRuntimeStorageDb,
  tryOpenRuntimeWalDb,
  getRuntimeWalDb,
  tryOpenHistoryViewDb,
  getHistoryViewDb,
  getPerfMs,
  formatPerfMs: (value) => value.toFixed(2),
  onPersistenceBoundary: (boundary: StoragePersistenceBoundary) => {
    if (boundary !== requestedBoundary) return;
    process.kill(process.pid, 'SIGKILL');
  },
});
throw new Error(`ACCOUNT_J_CRASH_BOUNDARY_NOT_REACHED:${requestedBoundary}`);
