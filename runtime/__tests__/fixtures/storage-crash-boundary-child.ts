import {
  closeInfraDb,
  closeRuntimeDb,
  createEmptyEnv,
  enqueueRuntimeInput,
  getFrameDb,
  getRuntimeStorageDb,
  persistRestoredEnvToDB,
  process as processRuntime,
  tryOpenStorageDb,
  tryOpenFrameDb,
} from '../../runtime';
import {
  deriveSignerAddressSync,
  deriveSignerKeySync,
  registerSignerKey,
  signAccountFrame,
} from '../../account/crypto';
import {
  applyEntityFrame,
} from '../../entity/consensus';
import { buildCollectiveEntityProposalTx } from '../../entity/authorization';
import { buildSignedEntityCommand } from '../../entity/command';
import { signedEntityCommandTx } from '../../entity/command-codec';
import {
  createEntityFrameHashFromStateRoot,
} from '../../entity/consensus/frame';
import {
  buildEntityFrameAuthority,
  computeCanonicalEntityConsensusStateHash,
  computeEntityFrameAuthorityRoot,
} from '../../entity/consensus/state-root';
import { buildEntityHashesToSign } from '../../entity/consensus/hanko-witness';
import {
  buildEntityLeaderCertificate,
  buildEntityLeaderVoteBody,
  getEntityLeaderState,
  hashEntityLeaderVoteBody,
} from '../../entity/consensus/leader';
import { generateProposalId } from '../../entity/tx/proposals';
import { generateNumberedEntityId } from '../../entity/factory';
import { buildQuorumHanko, getEntityConfigBoardHash } from '../../hanko/signing';
import {
  canonicalJurisdictionEventsHash,
  getJEventJurisdictionRef,
} from '../../jurisdiction/event-observation';
import {
  buildJEventRangeDigest,
  canonicalJEventRangeHash,
  EMPTY_J_HISTORY_ROOT,
  foldJHistoryRoot,
} from '../../jurisdiction/history-consensus';
import {
  buildLocalJPrefixAttestation,
  mergeJPrefixAttestations,
} from '../../jurisdiction/j-prefix-consensus';
import { applyRuntimeStorageChanges } from '../../machine/env-events';
import { cloneIsolatedRuntimeInput } from '../../protocol/runtime-input-clone';
import { collectDueJSubmitRuntimeTxs } from '../../machine/j-submit-scheduler';
import { registerPendingCommittedJOutbox } from '../../machine/j-submit-state';
import { applyRuntimeTx } from '../../machine/tx-handlers';
import {
  saveRuntimeFrameToStorage,
  type StoragePersistenceBoundary,
} from '../../storage';
import { getPerfMs } from '../../utils';
import type {
  CertifiedRegistrationEvidence,
  CertifiedEntityFrameLink,
  EntityState,
  EntityTx,
  JReplica,
  JurisdictionConfig,
  JurisdictionEvent,
} from '../../types';
import {
  installCanonicalRegisteredBoardAuthority,
  installCanonicalRegistrationEvidence,
} from '../helpers/registration-evidence';

const [seed, requestedBoundary] = Bun.argv.slice(2);
if (!seed || !requestedBoundary) throw new Error('seed and persistence boundary are required');
const recoveryLagMode = requestedBoundary === 'restore-certified-lineage-lag';
const recoveryBoardRootLagMode = requestedBoundary === 'restore-certified-board-root-lag';
const boundary = requestedBoundary as StoragePersistenceBoundary;

const runtimeId = deriveSignerAddressSync(seed, '1').toLowerCase();
const signerA = deriveSignerAddressSync(seed, '1').toLowerCase();
const signerB = deriveSignerAddressSync(seed, '2').toLowerCase();
registerSignerKey(seed, signerA, deriveSignerKeySync(seed, '1'));
registerSignerKey(seed, signerB, deriveSignerKeySync(seed, '2'));
const entityId = generateNumberedEntityId(2).toLowerCase();
const jurisdiction: JurisdictionConfig = {
  name: 'storage-real-crash-boundary',
  address: 'browservm://storage-real-crash-boundary',
  depositoryAddress: '0x000000000000000000000000000000000000dead',
  entityProviderAddress: '0x000000000000000000000000000000000000beef',
  entityProviderDeploymentBlock: 1,
  registrationBlock: 2,
  chainId: 31337,
};

const blockHash = (byte: string): string => `0x${byte.repeat(32)}`;
const uint256Hash = (value: number): string => `0x${BigInt(value).toString(16).padStart(64, '0')}`;

const makeBoardEvents = (
  boardHash: string,
  registration: CertifiedRegistrationEvidence,
): JurisdictionEvent[] => [{
  type: 'FoundationBootstrapped',
  data: {
    recipient: runtimeId,
    boardHash: blockHash('00'),
    controlTokenId: '2',
    dividendTokenId: '3',
  },
  blockNumber: 1,
  blockHash: uint256Hash(1),
  transactionHash: uint256Hash(33),
  logIndex: 0,
}, {
  type: 'EntityRegistered',
  data: {
    entityId,
    entityNumber: BigInt(entityId).toString(),
    boardHash,
  },
  blockNumber: registration.activationHeight,
  blockHash: registration.blockHash,
  transactionHash: registration.transactionHash,
  logIndex: registration.logIndex,
}, {
  type: 'ReserveUpdated',
  data: {
    entity: entityId,
    tokenId: 1,
    newBalance: '100',
  },
  blockNumber: registration.activationHeight + 1,
  blockHash: blockHash('03'),
  transactionHash: blockHash('23'),
  logIndex: 0,
}];

const buildCertifiedBoardRangeTx = (
  state: EntityState,
  events: JurisdictionEvent[],
): EntityTx => {
  const jurisdictionRef = getJEventJurisdictionRef(jurisdiction);
  let eventHistoryRoot = state.jHistoryFinality?.eventHistoryRoot ?? EMPTY_J_HISTORY_ROOT;
  const grouped = new Map<number, JurisdictionEvent[]>();
  for (const event of events) {
    grouped.set(event.blockNumber, [...(grouped.get(event.blockNumber) ?? []), event]);
  }
  const blocks = Array.from(grouped.entries()).sort(([left], [right]) => left - right).map(([
    height,
    blockEvents,
  ]) => {
    const eventsHash = canonicalJurisdictionEventsHash(blockEvents);
    const jBlockHash = blockEvents[0]!.blockHash;
    eventHistoryRoot = foldJHistoryRoot(eventHistoryRoot, [{
      jurisdictionRef,
      jHeight: height,
      jBlockHash,
      eventsHash,
    }]);
    return { blockNumber: height, blockHash: jBlockHash, eventsHash, events: blockEvents };
  });
  const last = blocks.at(-1)!;
  const unsigned = {
    jurisdictionRef,
    baseHeight: state.lastFinalizedJHeight,
    scannedThroughHeight: last.blockNumber,
    tipBlockHash: last.blockHash,
    eventHistoryRoot,
    rangeHash: canonicalJEventRangeHash(jurisdictionRef, blocks),
    blocks,
  };
  return {
    type: 'j_event',
    data: {
      from: signerA,
      observedAt: last.blockNumber,
      signature: signAccountFrame(env, signerA, buildJEventRangeDigest({
        entityId: state.entityId,
        signerId: signerA,
        ...unsigned,
      })),
      ...unsigned,
    },
  };
};

const certifyNextFrame = async (
  state: EntityState,
  txs: EntityTx[],
): Promise<{ state: EntityState; link: CertifiedEntityFrameLink }> => {
  const height = state.height + 1;
  const timestamp = env.timestamp;
  const applied = await applyEntityFrame(env, state, txs, timestamp);
  const postStateWithoutHead: EntityState = {
    ...applied.newState,
    entityId: state.entityId,
    height,
    timestamp,
    leaderState: getEntityLeaderState(state),
  };
  const stateRoot = computeCanonicalEntityConsensusStateHash(postStateWithoutHead);
  const postAuthority = buildEntityFrameAuthority(postStateWithoutHead);
  const authorityRoot = computeEntityFrameAuthorityRoot(postAuthority);
  const parentFrameHash = state.height === 0 ? 'genesis' : String(state.prevFrameHash || '');
  if (!parentFrameHash) throw new Error(`crash fixture parent frame missing at ${state.height}`);
  const hash = createEntityFrameHashFromStateRoot(
    parentFrameHash,
    height,
    timestamp,
    txs,
    state.entityId,
    stateRoot,
    authorityRoot,
  );
  const hashesToSign = buildEntityHashesToSign(
    state.entityId,
    height,
    hash,
    applied.collectedHashes ?? [],
  );
  return {
    state: { ...postStateWithoutHead, prevFrameHash: hash },
    link: {
      frame: {
        parentFrameHash,
        height,
        timestamp,
        txs,
        hash,
        stateRoot,
        authorityRoot,
        leader: { proposerSignerId: signerA, view: getEntityLeaderState(state).view },
        hashesToSign,
        collectedSigs: new Map([signerA, signerB].map(signerId => [
          signerId,
          hashesToSign.map(hashInfo => signAccountFrame(env, signerId, hashInfo.hash)),
        ])),
      },
      postAuthority,
    },
  };
};

const env = createEmptyEnv(seed);
env.runtimeId = runtimeId;
env.dbNamespace = runtimeId;
env.quietRuntimeLogs = true;
env.runtimeConfig = {
  ...env.runtimeConfig,
  storage: {
    // The crash-boundary fixture installs an already-certified checkpoint
    // below. Do not persist the earlier synthetic construction steps as if
    // they were a replayable Runtime frame.
    enabled: recoveryLagMode || recoveryBoardRootLagMode,
    snapshotPeriodFrames: 1,
    retainSnapshots: 1,
    epochMaxBytes: 1_000_000_000,
    frameDbMaxBytes: 1,
    frameDbRetainFrames: 1,
    materializePeriodFrames: 1_000,
    canonicalHashPeriodFrames: 1,
    accountMerkleRadix: 16,
  },
};
env.activeJurisdiction = jurisdiction.name;
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
  watcherConfirmationDepth: 0,
} as JReplica);
const entityConfig = {
  mode: 'proposer-based' as const,
  threshold: 2n,
  validators: [signerA, signerB],
  shares: { [signerA]: 1n, [signerB]: 1n },
  jurisdiction,
};
const registeredBoardHash = await getEntityConfigBoardHash(env, entityConfig);
await installCanonicalRegistrationEvidence(
  env,
  jurisdiction,
  entityId,
  registeredBoardHash,
  { activationHeight: 2 },
);
enqueueRuntimeInput(env, {
  runtimeTxs: [signerA, signerB].map((signerId, index) => ({
    type: 'importReplica' as const,
    entityId,
    signerId,
    data: {
      isProposer: index === 0,
      config: entityConfig,
    },
  })),
  entityInputs: [],
});
await processRuntime(env, []);

// Install the exact Entity-certified authority only after the bootstrap frame.
// The following save must therefore publish every newly-referenced immutable
// node in the same authoritative batch as the root-bearing Entity documents.
const firstReplica = Array.from(env.eReplicas.values()).find((candidate) => (
  candidate.entityId === entityId && candidate.signerId === signerA
));
if (!firstReplica) throw new Error('crash fixture authority replica missing');
const restoredBoardHash = await getEntityConfigBoardHash(env, firstReplica.state.config);
if (restoredBoardHash !== registeredBoardHash) {
  throw new Error(`crash fixture restored board mismatch: ${restoredBoardHash}:${registeredBoardHash}`);
}
const registrationEvidence = await installCanonicalRegisteredBoardAuthority(
  env,
  jurisdiction,
  firstReplica.state,
  registeredBoardHash,
  { activationHeight: 2 },
);
const boardEvents = makeBoardEvents(registeredBoardHash, registrationEvidence);
const collectiveTxs: EntityTx[] = [{
  type: 'r2r',
  data: {
    toEntityId: `0x${'cd'.repeat(32)}`,
    tokenId: 1,
    amount: 7n,
  },
}, {
  type: 'j_broadcast',
  data: {},
}, {
  type: 'chatMessage',
  data: { message: 'certified-height-one', timestamp: env.timestamp },
}];
const proposalTx = buildCollectiveEntityProposalTx(signerA, collectiveTxs);
if (proposalTx.type !== 'propose') throw new Error('crash fixture collective proposal missing');
const proposalId = generateProposalId(
  env,
  proposalTx.data.action,
  signerA,
  { ...firstReplica.state, timestamp: env.timestamp },
);
const certifiedHeightOne = await certifyNextFrame(
  firstReplica.state,
  [
    buildCertifiedBoardRangeTx(firstReplica.state, boardEvents),
    signedEntityCommandTx(buildSignedEntityCommand(env, firstReplica.state, signerA, [proposalTx])),
    signedEntityCommandTx(buildSignedEntityCommand(env, firstReplica.state, signerB, [{
      type: 'vote',
      data: { proposalId, voter: signerB, choice: 'yes' },
    }])),
  ],
);

// A quorum-certified Entity frame reaches local replicas over later reliable
// R-frames. Persist the legal transient where the proposer already committed
// height 1 while the second validator is still durably catching up from 0.
// Shared storage must materialize the highest committed state, while replica
// metadata must retain each validator's exact local state for crash recovery.
firstReplica.state = certifiedHeightOne.state;
firstReplica.certifiedFrameLineage = [certifiedHeightOne.link];

const replica = Array.from(env.eReplicas.values()).find((candidate) => (
  candidate.entityId === entityId && candidate.signerId === signerB
));
if (!replica) throw new Error('crash fixture replica missing');
const voteBody = buildEntityLeaderVoteBody(replica.state);
const votes = new Map([signerA, signerB].map((voterId) => {
  const unsigned = { ...voteBody, voterId, signature: '' };
  return [voterId, {
    ...unsigned,
    signature: signAccountFrame(env, voterId, hashEntityLeaderVoteBody(unsigned)),
  }];
}));
replica.leaderVotes = votes;
replica.pendingLeaderCertificate = buildEntityLeaderCertificate(voteBody, votes);
replica.lastConsensusProgressAt = 12_345;
const observedBlockHash = `0x${'ab'.repeat(32)}`;
replica.jHistory = {
  jurisdictionRef: getJEventJurisdictionRef(jurisdiction),
  scannedThroughHeight: 7,
  contiguousThroughHeight: 7,
  tipBlockHash: observedBlockHash,
  eventBlocks: new Map(),
  blockHashes: new Map(Array.from({ length: 7 }, (_, index) => {
    const height = index + 1;
    return [height, height === 7 ? observedBlockHash : blockHash(height.toString(16).padStart(2, '0'))];
  })),
};
const jPrefixHeads = new Map([signerA, signerB].map((signerId) => {
  const attestation = buildLocalJPrefixAttestation(env, {
    ...replica,
    signerId,
  });
  if (!attestation) throw new Error(`crash fixture J-prefix attestation missing: ${signerId}`);
  return [signerId, attestation];
}));
replica.jPrefixRound = mergeJPrefixAttestations(env, replica.state, undefined, jPrefixHeads);
if (!replica.jPrefixRound.certificate) {
  throw new Error('crash fixture J-prefix quorum certificate missing');
}

const sentBatch = firstReplica.state.jBatchState?.sentBatch;
if (!sentBatch) throw new Error('crash fixture certified sent batch missing');
const { batch, encodedBatch, batchHash } = sentBatch;
const quorumHanko = await buildQuorumHanko(
  env,
  entityId,
  batchHash,
  [signerA, signerB].map((signerId) => ({
    signerId,
    signature: signAccountFrame(env, signerId, batchHash),
  })),
  firstReplica.state.config,
  firstReplica.state,
);
for (const candidate of env.eReplicas.values()) {
  candidate.state.htlcNotes = new Map([
    [`lock:0x${'ef'.repeat(32)}`, `private-note:${candidate.signerId}`],
  ]);
}
const proposerReplica = Array.from(env.eReplicas.values()).find((candidate) => (
  candidate.entityId === entityId && candidate.signerId === signerA
));
if (!proposerReplica) throw new Error('crash fixture proposer replica missing');
proposerReplica.hankoWitness = new Map([[batchHash, {
  hanko: quorumHanko,
  type: 'jBatch',
  entityHeight: proposerReplica.state.height,
  createdAt: env.timestamp,
}]]);

if (!recoveryLagMode && !recoveryBoardRootLagMode) {
  env.runtimeConfig.storage = { ...env.runtimeConfig.storage, enabled: true };
  applyRuntimeStorageChanges(env, [{ family: 'entity', entityId }]);
  await saveRuntimeFrameToStorage({
    env,
    currentFrameInput: { runtimeTxs: [], entityInputs: [] },
    tryOpenDb: tryOpenStorageDb,
    getRuntimeDb: getRuntimeStorageDb,
    tryOpenFrameDb,
    getFrameDb,
    getPerfMs,
    formatPerfMs: (value) => Math.round(value * 1_000) / 1_000,
  });
  // Live process() assigns the new Runtime frame's height and timestamp before
  // applying its input. Replay does the same, so attempt bytes stay identical.
  env.height += 1;
  env.timestamp += 1;
}
const [retry] = collectDueJSubmitRuntimeTxs(env, env.timestamp);
if (!retry) throw new Error('crash fixture J-submit retry missing');
registerPendingCommittedJOutbox(env, await applyRuntimeTx(env, retry, { isReplay: true }));
const appliedRuntimeInput = cloneIsolatedRuntimeInput({ runtimeTxs: [retry], entityInputs: [] });
applyRuntimeStorageChanges(env, [{ family: 'entity', entityId }]);

if (recoveryLagMode || recoveryBoardRootLagMode) {
  env.height += 1;
  env.timestamp += 1;
  const laggingEntry = Array.from(env.eReplicas.entries()).find(([, candidate]) => (
    candidate.entityId === entityId && candidate.signerId === signerB
  ));
  const certifiedEntry = Array.from(env.eReplicas.entries()).find(([, candidate]) => (
    candidate.entityId === entityId && candidate.signerId === signerA
  ));
  if (!laggingEntry || !certifiedEntry) throw new Error('recovery lag fixture replicas missing');
  if (recoveryBoardRootLagMode) {
    const rotationHeight = certifiedHeightOne.state.lastFinalizedJHeight + 1;
    const rotation: JurisdictionEvent = {
      type: 'BoardActivated',
      data: {
        entityId,
        previousBoardHash: registeredBoardHash,
        newBoardHash: registeredBoardHash,
        previousBoardValidUntil: String(Math.floor(env.timestamp / 1_000) + 7 * 24 * 60 * 60),
      },
      blockNumber: rotationHeight,
      blockHash: blockHash('04'),
      transactionHash: blockHash('24'),
      logIndex: 0,
    };
    const certifiedHeightTwo = await certifyNextFrame(
      certifiedHeightOne.state,
      [buildCertifiedBoardRangeTx(certifiedHeightOne.state, [rotation])],
    );
    const laggingLocalIdentity = {
      entityEncPubKey: laggingEntry[1].state.entityEncPubKey,
      entityEncPrivKey: laggingEntry[1].state.entityEncPrivKey,
      htlcNotes: structuredClone(laggingEntry[1].state.htlcNotes),
    };
    laggingEntry[1].state = {
      ...structuredClone(certifiedHeightOne.state),
      ...laggingLocalIdentity,
    };
    laggingEntry[1].certifiedFrameLineage = [structuredClone(certifiedHeightOne.link)];
    certifiedEntry[1].state = certifiedHeightTwo.state;
    certifiedEntry[1].certifiedFrameLineage = [
      structuredClone(certifiedHeightOne.link),
      certifiedHeightTwo.link,
    ];

    // This fixture advances the two replicas by installing already-certified
    // checkpoints directly. Rebase signer B's validator-local header cache to
    // the exact Entity-certified hashes before persisting it. Leaving the old
    // synthetic H2 header here models a finalized reorg, not replica lag, and
    // restore must correctly reject that corruption.
    const laggingHistory = laggingEntry[1].jHistory;
    if (!laggingHistory) throw new Error('recovery board-root lag J-history missing');
    const certifiedHashes = new Map(
      laggingEntry[1].state.jBlockChain.map((block) => [block.jHeight, block.jBlockHash]),
    );
    laggingEntry[1].jHistory = {
      ...laggingHistory,
      blockHashes: new Map(Array.from(laggingHistory.blockHashes, ([height, hash]) => [
        height,
        certifiedHashes.get(height) ?? hash,
      ])),
    };

    // The direct checkpoint install changes height/parent outside the normal
    // commit path, so round-scoped votes from the old parent are no longer
    // valid progress. A normal commit clears them for the same reason.
    laggingEntry[1].jPrefixRound = undefined;
    certifiedEntry[1].jPrefixRound = undefined;
  }
  // A Map's insertion order is transport timing, never a canonical state selector.
  env.eReplicas = new Map([laggingEntry, certifiedEntry]);
  await persistRestoredEnvToDB(env);
  await closeRuntimeDb(env);
  await closeInfraDb(env);
} else {
  await saveRuntimeFrameToStorage({
    env,
    // WAL stores causal inputs, not a duplicate full Env. The live mutation
    // above deliberately bypasses process() so this crash fixture must provide
    // the exact input that deterministically rebuilds the durable J attempt.
    currentFrameInput: appliedRuntimeInput,
    tryOpenDb: tryOpenStorageDb,
    getRuntimeDb: getRuntimeStorageDb,
    tryOpenFrameDb,
    getFrameDb,
    getPerfMs,
    formatPerfMs: (value) => Math.round(value * 1_000) / 1_000,
    onPersistenceBoundary: (reached) => {
      if (reached !== boundary) return;
      process.kill(process.pid, 'SIGKILL');
    },
  });
  throw new Error(`fault boundary was not reached: ${boundary}`);
}
