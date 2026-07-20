import { describe, expect, test } from 'bun:test';

import {
  deriveSignerAddressSync,
  deriveSignerKeySync,
  registerSignerKey,
  signAccountFrame,
} from '../account/crypto';
import { applyEntityFrame, applyEntityInput } from '../entity/consensus';
import { createEntityFrameHash } from '../entity/consensus/frame';
import { buildEntityHashesToSign } from '../entity/consensus/hanko-witness';
import { getEntityLeaderState } from '../entity/consensus/leader';
import { buildCertifiedEntityOutputHashes } from '../entity/consensus/output-certification';
import {
  buildEntityFrameAuthority,
  computeCanonicalEntityConsensusStateHash,
  computeEntityFrameAuthorityRoot,
} from '../entity/consensus/state-root';
import { generateLazyEntityId } from '../entity/factory';
import { deriveLocalEntityCryptoKeys } from '../entity/crypto';
import { initCrontab } from '../entity/scheduler';
import { buildQuorumHanko } from '../hanko/signing';
import { startRuntimeHistoryTraceForTesting } from '../history-retention';
import { buildLocalEntityProfile } from '../networking/gossip-helper';
import {
  collectLocalProfileEncryptionAnnouncements,
  getCompleteProfileEncryptionManifest,
} from '../networking/profile-encryption';
import { computeProfileHash } from '../networking/profile-signing';
import { safeStringify } from '../protocol/serialization';
import { canonicalJurisdictionEventsHash } from '../jurisdiction/event-observation';
import { recordValidatorJHistory } from '../jurisdiction/local-history';
import { markLocalJAuthorityRuntimeTx } from '../jurisdiction/registration-evidence';
import { buildRuntimeRecoveryBundle } from '../recovery/bundle';
import { applyMergedEntityInputs } from '../machine/entity-inputs';
import type { RuntimeEntityRoutingDeps } from '../machine/entity-routing';
import {
  applyReliableDeliveryReceipts,
  commitReliableIngress,
  finalizeReliableIngressCommit,
  registerReliableIngress,
  releaseUncommittedReliableIngress,
} from '../machine/reliable-delivery';
import {
  closeInfraDb,
  createEmptyEnv,
  enqueueRuntimeInput,
  process as processRuntime,
  restoreEnvFromRecoveryBundles,
} from '../runtime';
import {
  computeCanonicalEntityHashesFromEnv,
  computeCanonicalRuntimeStateHash,
  computeCanonicalStateHashFromEnv,
} from '../storage/canonical-hash';
import { buildStorageReplicaMetaCommitment } from '../storage/replicas';
import {
  applyCertifiedEntityLineagePlan,
  buildCertifiedEntityLineagePlan,
} from '../storage/entity-lineage';
import type {
  DeliverableEntityInput,
  EntityReplica,
  EntityState,
  Env,
  JurisdictionEvent,
  ProposedEntityFrame,
} from '../types';
import { buildDurableRuntimeMachineSnapshot, restoreDurableRuntimeSnapshot } from '../wal/snapshot';
import type { PersistedFrameJournal } from '../wal/store';

const TEST_RUN_ID = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;

const createRuntime = (seed: string): Env => {
  const env = createEmptyEnv(seed);
  const runtimeId = deriveSignerAddressSync(seed, '1').toLowerCase();
  registerSignerKey(env, runtimeId, deriveSignerKeySync(seed, '1'));
  env.runtimeId = runtimeId;
  env.runtimeSeed = seed;
  env.scenarioMode = true;
  env.quietRuntimeLogs = true;
  env.runtimeConfig = { storage: { enabled: false } };
  env.runtimeState ??= {};
  return env;
};

const routingDeps: RuntimeEntityRoutingDeps = {
  ensureRuntimeState: env => (env.runtimeState ??= {}),
  enqueueRuntimeInputs: () => {},
  extractEntityId: replicaKey => String(replicaKey).split(':')[0] || '',
  hasLocalSignerForEntity: () => false,
  hasLocalSignerForEntitySigner: () => false,
  resolveSoleLocalSignerForEntity: () => null,
  getP2P: () => null,
};

const createEntityState = (
  signerId: string,
  validators: string[] = [signerId],
  threshold = 1n,
): EntityState => {
  const entityId = generateLazyEntityId(validators, threshold).toLowerCase();
  return {
    entityId,
    height: 0,
    timestamp: 0,
    nonces: new Map(),
    messages: [],
    proposals: new Map(),
    config: {
      mode: 'proposer-based',
      threshold,
      validators,
      shares: Object.fromEntries(validators.map(validatorId => [validatorId, 1n])),
    },
    reserves: new Map(),
    accounts: new Map(),
    deferredAccountProposals: new Map(),
    crontabState: initCrontab(),
    lastFinalizedJHeight: 0,
    jBlockChain: [],
    entityEncPubKey: `0x${'11'.repeat(32)}`,
    entityEncPrivKey: `0x${'22'.repeat(32)}`,
    profile: { name: 'catch-up validator', isHub: false, avatar: '', bio: '', website: '' },
    htlcRoutes: new Map(),
    htlcFeesEarned: 0n,
    htlcNotes: new Map(),
    lockBook: new Map(),
    swapTradingPairs: [],
    pendingSwapFillRatios: new Map(),
  };
};

const buildCommitCertificate = async (
  env: Env,
  state: EntityState,
  signerIds: string | string[],
  timestamp: number,
): Promise<{ frame: ProposedEntityFrame; nextState: EntityState }> => {
  const certificateSigners = Array.isArray(signerIds) ? signerIds : [signerIds];
  const height = state.height + 1;
  const execution = await applyEntityFrame(env, state, [], timestamp);
  const nextStateBeforeLink: EntityState = {
    ...execution.newState,
    entityId: state.entityId,
    height,
    timestamp,
    leaderState: getEntityLeaderState(state),
  };
  const previousFrameHash = state.height === 0 ? 'genesis' : state.prevFrameHash;
  if (!previousFrameHash) throw new Error(`TEST_PREVIOUS_FRAME_HASH_MISSING:${state.height}`);
  const frameHash = await createEntityFrameHash(
    previousFrameHash,
    height,
    timestamp,
    [],
    nextStateBeforeLink,
  );
  const outputHashes = buildCertifiedEntityOutputHashes(
    nextStateBeforeLink,
    env,
    height,
    frameHash,
    execution.outputs,
  );
  const hashesToSign = buildEntityHashesToSign(
    state.entityId,
    height,
    frameHash,
    [...(execution.collectedHashes ?? []), ...outputHashes],
  );
  const signaturesBySigner = new Map(certificateSigners.map(certificateSignerId => [
    certificateSignerId,
    hashesToSign.map(hashInfo => signAccountFrame(env, certificateSignerId, hashInfo.hash)),
  ]));
  const hankos = await Promise.all(hashesToSign.map((hashInfo, index) => buildQuorumHanko(
    env,
    state.entityId,
    hashInfo.hash,
    certificateSigners.map(certificateSignerId => ({
      signerId: certificateSignerId,
      signature: signaturesBySigner.get(certificateSignerId)![index]!,
    })),
    state.config,
  )));
  const frame: ProposedEntityFrame = {
    height,
    parentFrameHash: previousFrameHash,
    stateRoot: computeCanonicalEntityConsensusStateHash(nextStateBeforeLink),
    authorityRoot: computeEntityFrameAuthorityRoot(buildEntityFrameAuthority(nextStateBeforeLink)),
    timestamp,
    txs: [],
    hash: frameHash,
    leader: { proposerSignerId: state.config.validators[0]!, view: 0 },
    hashesToSign,
    collectedSigs: signaturesBySigner,
    hankos,
  };
  return {
    frame,
    nextState: { ...nextStateBeforeLink, prevFrameHash: frameHash },
  };
};

const deliverable = (
  receiverRuntimeId: string,
  entityId: string,
  signerId: string,
  frame: ProposedEntityFrame,
): DeliverableEntityInput => ({
  runtimeId: receiverRuntimeId,
  entityId,
  signerId,
  proposedFrame: structuredClone(frame),
});

const installReplica = (env: Env, state: EntityState, signerId: string): void => {
  const replica: EntityReplica = {
    entityId: state.entityId,
    signerId,
    state: structuredClone(state),
    mempool: [],
    isProposer: true,
  };
  env.eReplicas.set(`${state.entityId}:${signerId}`, replica);
};

const reliableRecoveryProjection = (env: Env): Record<string, unknown> => ({
  pendingNetworkOutputs: env.pendingNetworkOutputs ?? [],
  reliableIngressReceiptLedger: env.runtimeState?.reliableIngressReceiptLedger ?? new Map(),
  reliableIngressTerminalWatermarks: env.runtimeState?.reliableIngressTerminalWatermarks ?? new Map(),
  receivedReliableReceiptLedger: env.runtimeState?.receivedReliableReceiptLedger ?? new Map(),
  receivedReliableTerminalWatermarks: env.runtimeState?.receivedReliableTerminalWatermarks ?? new Map(),
});

describe('ordered reliable Entity catch-up', () => {
  test('future proposal is explicitly deferred instead of falsely committed', async () => {
    const entitySeed = `entity-catch-up-l1-${TEST_RUN_ID}`;
    const signerId = deriveSignerAddressSync(entitySeed, '1').toLowerCase();
    const env = createRuntime(`entity-catch-up-l1-runtime-${TEST_RUN_ID}`);
    registerSignerKey(env, signerId, deriveSignerKeySync(entitySeed, '1'));
    const state = createEntityState(signerId);
    const replica: EntityReplica = {
      entityId: state.entityId,
      signerId,
      state,
      mempool: [],
      isProposer: true,
    };
    const future = await buildCommitCertificate(env, {
      ...(await buildCommitCertificate(env, state, signerId, 100)).nextState,
    }, signerId, 200);
    const proposalOnly = structuredClone(future.frame);
    proposalOnly.collectedSigs = new Map();
    delete proposalOnly.hankos;

    const result = await applyEntityInput(env, replica, {
      entityId: state.entityId,
      signerId,
      proposedFrame: proposalOnly,
    });

    expect(result.outcome).toEqual({ kind: 'deferred', reason: 'PROPOSAL_CATCH_UP_STATE_WAIT' });
    expect(result.workingReplica.state.height).toBe(0);
    expect(result.workingReplica.proposal).toBeUndefined();
  });

  test('replays an older quorum certificate without treating a later local J event as signer freshness', async () => {
    const entitySeed = `entity-catch-up-j-future-${TEST_RUN_ID}`;
    const leaderSignerId = deriveSignerAddressSync(`${entitySeed}-leader`, '1').toLowerCase();
    const quorumSignerId = deriveSignerAddressSync(`${entitySeed}-quorum`, '1').toLowerCase();
    const catchUpSignerId = deriveSignerAddressSync(`${entitySeed}-catch-up`, '1').toLowerCase();
    const env = createRuntime(`entity-catch-up-j-future-runtime-${TEST_RUN_ID}`);
    for (const [signerId, seed] of [
      [leaderSignerId, `${entitySeed}-leader`],
      [quorumSignerId, `${entitySeed}-quorum`],
      [catchUpSignerId, `${entitySeed}-catch-up`],
    ] as const) {
      registerSignerKey(env, signerId, deriveSignerKeySync(seed, '1'));
    }
    const initialState = createEntityState(
      catchUpSignerId,
      [leaderSignerId, quorumSignerId, catchUpSignerId],
      2n,
    );
    const certifiedBeforeObservation = await buildCommitCertificate(
      env,
      initialState,
      [leaderSignerId, quorumSignerId],
      100,
    );
    const laterBlockHash = `0x${'ab'.repeat(32)}`;
    const laterEvent: JurisdictionEvent = {
      blockNumber: 1,
      blockHash: laterBlockHash,
      transactionHash: `0x${'cd'.repeat(32)}`,
      logIndex: 0,
      type: 'ReserveUpdated',
      data: {
        entity: initialState.entityId,
        tokenId: 1,
        newBalance: '1',
      },
    };
    const replica: EntityReplica = {
      entityId: initialState.entityId,
      signerId: catchUpSignerId,
      state: structuredClone(initialState),
      mempool: [],
      isProposer: false,
      jHistory: recordValidatorJHistory(undefined, {
        jurisdictionRef: 'unconfigured',
        scannedThroughHeight: 1,
        tipBlockHash: laterBlockHash,
        headers: [{ jHeight: 1, jBlockHash: laterBlockHash }],
        blocks: [{
          jurisdictionRef: 'unconfigured',
          jHeight: 1,
          jBlockHash: laterBlockHash,
          eventsHash: canonicalJurisdictionEventsHash([laterEvent]),
          events: [laterEvent],
        }],
      }),
    };

    const result = await applyEntityInput(env, replica, {
      entityId: initialState.entityId,
      signerId: catchUpSignerId,
      proposedFrame: structuredClone(certifiedBeforeObservation.frame),
    });

    expect(result.outcome).toEqual({ kind: 'committed' });
    expect(result.workingReplica.state.height).toBe(1);
    expect(result.workingReplica.state.lastFinalizedJHeight).toBe(0);
    expect(result.workingReplica.jHistory?.eventBlocks.has(1)).toBe(true);
    expect(certifiedBeforeObservation.frame.collectedSigs?.has(catchUpSignerId)).toBe(false);
  });

  test('H+2 first survives duplicate/restart and commits only after H+1 certificate catch-up', async () => {
    const entitySeed = `entity-catch-up-l2-${TEST_RUN_ID}`;
    const signerId = deriveSignerAddressSync(entitySeed, '1').toLowerCase();
    const sender = createRuntime(`entity-catch-up-sender-${TEST_RUN_ID}`);
    const receiver = createRuntime(`entity-catch-up-receiver-${TEST_RUN_ID}`);
    registerSignerKey(receiver, signerId, deriveSignerKeySync(entitySeed, '1'));
    const initialState = createEntityState(signerId);
    installReplica(receiver, initialState, signerId);

    const heightOne = await buildCommitCertificate(receiver, initialState, signerId, 100);
    const heightTwo = await buildCommitCertificate(receiver, heightOne.nextState, signerId, 200);
    const h1 = deliverable(receiver.runtimeId!, initialState.entityId, signerId, heightOne.frame);
    const h2 = deliverable(receiver.runtimeId!, initialState.entityId, signerId, heightTwo.frame);
    sender.pendingNetworkOutputs = [structuredClone(h1), structuredClone(h2)];

    expect(registerReliableIngress(receiver, sender.runtimeId!, h2).kind).toBe('enqueue');
    expect(registerReliableIngress(receiver, sender.runtimeId!, h2).kind).toBe('pending');
    const futureAttempt = await applyMergedEntityInputs(receiver, [h2], [], {
      isReplay: false,
      routingDeps,
    });
    expect(futureAttempt.appliedEntityInputs).toEqual([]);
    expect(receiver.eReplicas.get(`${initialState.entityId}:${signerId}`)?.state.height).toBe(0);
    expect(commitReliableIngress(receiver, futureAttempt.appliedEntityInputs)).toEqual([]);
    releaseUncommittedReliableIngress(receiver, [h2], futureAttempt.appliedEntityInputs);
    expect(receiver.runtimeState?.pendingReliableIngress?.size ?? 0).toBe(0);
    expect(sender.pendingNetworkOutputs).toHaveLength(2);

    const machineSnapshot = buildDurableRuntimeMachineSnapshot(receiver);
    const restarted = createRuntime(`entity-catch-up-receiver-${TEST_RUN_ID}`);
    installReplica(restarted, initialState, signerId);
    restoreDurableRuntimeSnapshot(restarted, machineSnapshot);
    expect(restarted.runtimeState?.reliableIngressReceiptLedger?.size ?? 0).toBe(0);
    expect(registerReliableIngress(restarted, sender.runtimeId!, h2).kind).toBe('enqueue');
    releaseUncommittedReliableIngress(restarted, [h2], []);

    // A quorum certificate for the exact next height is sufficient catch-up
    // evidence even when this validator never received the proposal.
    expect(registerReliableIngress(restarted, sender.runtimeId!, h1).kind).toBe('enqueue');
    const firstCommit = await applyMergedEntityInputs(restarted, [h1], [], {
      isReplay: false,
      routingDeps,
    });
    expect(firstCommit.appliedEntityInputs).toHaveLength(1);
    expect(restarted.eReplicas.get(`${initialState.entityId}:${signerId}`)?.state.height).toBe(1);
    const h1Commits = commitReliableIngress(restarted, firstCommit.appliedEntityInputs);
    expect(h1Commits).toHaveLength(1);
    finalizeReliableIngressCommit(restarted, h1Commits);

    // Drop the first receipt. Exact retry regenerates it from the durable
    // ledger and must not acknowledge or collect H+2.
    const regeneratedH1 = registerReliableIngress(restarted, sender.runtimeId!, h1);
    expect(regeneratedH1.kind).toBe('receipt');
    applyReliableDeliveryReceipts(sender, [regeneratedH1.receipt!]);
    expect(sender.pendingNetworkOutputs).toEqual([h2]);

    expect(registerReliableIngress(restarted, sender.runtimeId!, h2).kind).toBe('enqueue');
    const secondCommit = await applyMergedEntityInputs(restarted, [h2], [], {
      isReplay: false,
      routingDeps,
    });
    expect(secondCommit.appliedEntityInputs).toHaveLength(1);
    expect(restarted.eReplicas.get(`${initialState.entityId}:${signerId}`)?.state.height).toBe(2);
    const h2Commits = commitReliableIngress(restarted, secondCommit.appliedEntityInputs);
    expect(h2Commits).toHaveLength(1);
    finalizeReliableIngressCommit(restarted, h2Commits);
    applyReliableDeliveryReceipts(sender, [h2Commits[0]!.receipt]);

    expect(sender.pendingNetworkOutputs).toEqual([]);
    expect(restarted.runtimeState?.reliableIngressReceiptLedger?.size ?? 0).toBe(0);
    expect(restarted.runtimeState?.reliableIngressTerminalWatermarks?.size).toBe(1);
    expect(h1Commits[0]!.receipt!.body.identity.height).toBe(1);
    expect(h2Commits[0]!.receipt!.body.identity.height).toBe(2);
    expect(h1Commits[0]!.receipt!.body.identity.frameHash).toBe(heightOne.frame.hash);
    expect(h2Commits[0]!.receipt!.body.identity.frameHash).toBe(heightTwo.frame.hash);
  });

  test('local valid H+2 remains durable across defer/restart and commits after H+1', async () => {
    const entitySeed = `entity-catch-up-local-${TEST_RUN_ID}`;
    const leaderSignerId = deriveSignerAddressSync(`${entitySeed}-leader`, '1').toLowerCase();
    const signerId = deriveSignerAddressSync(entitySeed, '1').toLowerCase();
    const receiverSeed = `entity-catch-up-local-runtime-${TEST_RUN_ID}`;
    const receiver = createRuntime(receiverSeed);
    const builder = createRuntime(`entity-catch-up-local-builder-${TEST_RUN_ID}`);
    const leaderPrivateKey = deriveSignerKeySync(`${entitySeed}-leader`, '1');
    const signerPrivateKey = deriveSignerKeySync(entitySeed, '1');
    for (const signingEnv of [receiver, builder]) {
      registerSignerKey(signingEnv, leaderSignerId, leaderPrivateKey);
      registerSignerKey(signingEnv, signerId, signerPrivateKey);
    }
    const certificateSigners = [leaderSignerId, signerId];
    const initialState = createEntityState(signerId, certificateSigners, 2n);
    installReplica(receiver, initialState, signerId);
    const receiverReplica = receiver.eReplicas.get(`${initialState.entityId}:${signerId}`)!;
    receiverReplica.isProposer = false;
    const receiverEntityKeys = deriveLocalEntityCryptoKeys(receiver, initialState.entityId, signerId);
    receiverReplica.state.entityEncPubKey = receiverEntityKeys.publicKey;
    receiverReplica.state.entityEncPrivKey = receiverEntityKeys.privateKey;
    installReplica(receiver, initialState, leaderSignerId);
    const leaderReplica = receiver.eReplicas.get(`${initialState.entityId}:${leaderSignerId}`)!;
    const leaderEntityKeys = deriveLocalEntityCryptoKeys(receiver, initialState.entityId, leaderSignerId);
    leaderReplica.state.entityEncPubKey = leaderEntityKeys.publicKey;
    leaderReplica.state.entityEncPrivKey = leaderEntityKeys.privateKey;
    collectLocalProfileEncryptionAnnouncements(receiver);
    receiver.eReplicas.delete(`${initialState.entityId}:${leaderSignerId}`);
    const manifest = getCompleteProfileEncryptionManifest(receiver, receiverReplica.state);
    if (!manifest) throw new Error('TEST_LOCAL_PROFILE_MANIFEST_MISSING');
    initialState.profileEncryptionManifest = structuredClone(manifest);
    receiverReplica.state.profileEncryptionManifest = structuredClone(manifest);
    const profileHash = computeProfileHash(buildLocalEntityProfile(receiver, receiverReplica.state, 1));
    const profileSignatures = certificateSigners.map(certificateSignerId => ({
      signerId: certificateSignerId,
      signature: signAccountFrame(receiver, certificateSignerId, profileHash),
    }));
    const profileHanko = await buildQuorumHanko(
      receiver,
      initialState.entityId,
      profileHash,
      profileSignatures,
      initialState.config,
    );
    receiverReplica.hankoWitness = new Map([[profileHash, {
      hanko: profileHanko,
      type: 'profile',
      entityHeight: 0,
      createdAt: 1,
    }]]);
    applyCertifiedEntityLineagePlan(receiver, buildCertifiedEntityLineagePlan(receiver));
    const heightOne = await buildCommitCertificate(builder, initialState, certificateSigners, 100);
    const heightTwo = await buildCommitCertificate(builder, heightOne.nextState, certificateSigners, 200);
    const h1 = deliverable(receiver.runtimeId!, initialState.entityId, signerId, heightOne.frame);
    const h2 = deliverable(receiver.runtimeId!, initialState.entityId, signerId, heightTwo.frame);

    // Recovery journal tails require a non-zero snapshot anchor. Record a real
    // validator-local watcher observation through RuntimeTx instead of faking
    // R-height or importing an unrelated Entity.
    const observedBlockHash = `0x${'31'.repeat(32)}`;
    enqueueRuntimeInput(receiver, {
      runtimeTxs: [markLocalJAuthorityRuntimeTx({
        type: 'observeJRange',
        data: {
          entityId: initialState.entityId,
          signerId,
          jurisdictionRef: 'unconfigured',
          scannedThroughHeight: 1,
          tipBlockHash: observedBlockHash,
          headers: [{ jHeight: 1, jBlockHash: observedBlockHash }],
          blocks: [],
        },
      })],
      entityInputs: [],
    });
    await processRuntime(receiver, []);
    expect(receiver.height).toBe(1);

    expect(receiver.eReplicas.get(`${initialState.entityId}:${signerId}`)?.state.height).toBe(0);
    expect(receiver.pendingOutputs ?? []).toEqual([]);
    expect(receiver.networkInbox ?? []).toEqual([]);
    receiver.pendingNetworkOutputs = [structuredClone(h2)];
    await processRuntime(receiver, []);
    const firstTickReplica = receiver.eReplicas.get(`${initialState.entityId}:${signerId}`);
    expect(firstTickReplica?.state.height, safeStringify({
      runtimeHeight: receiver.height,
      runtimeInput: receiver.runtimeInput,
      runtimeMempool: receiver.runtimeMempool,
      historyInput: receiver.history?.at(-1)?.runtimeInput,
      replica: firstTickReplica,
    }, 2)).toBe(0);
    expect(receiver.pendingNetworkOutputs).toEqual([h2]);
    expect(receiver.runtimeMempool?.entityInputs).toEqual([h2]);

    await processRuntime(receiver, []);
    expect(receiver.eReplicas.get(`${initialState.entityId}:${signerId}`)?.state.height).toBe(0);
    expect(receiver.pendingNetworkOutputs).toEqual([h2]);
    expect(receiver.runtimeMempool?.entityInputs).toEqual([h2]);

    const recoverySigners = [{
      index: 0,
      address: receiver.runtimeId!,
      name: 'Reliable recovery runtime',
      entityId: initialState.entityId,
    }];
    const baseRecoveryBundle = buildRuntimeRecoveryBundle(receiver, {
      signers: recoverySigners,
      createdAt: 1_000,
    });
    const restarted = await restoreEnvFromRecoveryBundles([baseRecoveryBundle], {
      runtimeSeed: receiverSeed,
      runtimeId: receiver.runtimeId,
    });
    restarted.pendingNetworkOutputs = [structuredClone(h1), ...(restarted.pendingNetworkOutputs ?? [])];

    // Route H+1 first while the restored H+2 is still deferred. Then inject a
    // duplicate reordered H+2 into the same R-frame: before the durability
    // barrier this applied H+1 and H+2 before a single WAL save.
    await processRuntime(restarted, []);
    expect(restarted.eReplicas.get(`${initialState.entityId}:${signerId}`)?.state.height).toBe(0);
    const runtimeMachineBeforeHeightOne = buildDurableRuntimeMachineSnapshot(restarted, {
      pendingNetworkOutputs: restarted.pendingNetworkOutputs ?? [],
      includeIngressWorkingState: true,
    });
    const committedFrameTrace = startRuntimeHistoryTraceForTesting(restarted);
    try {
      await processRuntime(restarted, [structuredClone(h2)]);
    } finally {
      committedFrameTrace.stop();
    }
    const afterHeightOneReplica = restarted.eReplicas.get(`${initialState.entityId}:${signerId}`);
    expect(afterHeightOneReplica?.state.height).toBe(1);
    expect(afterHeightOneReplica?.state.prevFrameHash).toBe(heightOne.frame.hash);
    expect(committedFrameTrace.snapshots.at(-1)?.runtimeInput.entityInputs
      .map(input => input.proposedFrame?.height ?? null)).toEqual([1]);
    expect(restarted.pendingNetworkOutputs?.map(output => output.proposedFrame?.height ?? null)).toEqual([2]);
    expect(restarted.runtimeMempool?.entityInputs
      .map(input => input.proposedFrame?.height ?? null)).toEqual([2]);

    const committedHistoryFrame = committedFrameTrace.snapshots.at(-1);
    if (!committedHistoryFrame) throw new Error('TEST_RELIABLE_RECOVERY_HISTORY_FRAME_MISSING');
    const durableMachineAfterHeightOne = {
      ...buildDurableRuntimeMachineSnapshot(restarted, {
        pendingNetworkOutputs: restarted.pendingNetworkOutputs ?? [],
      }),
      // The duplicate H+2 arrived while H+1 was processing. It enters the next
      // live mempool only after the H+1 durability fence; therefore the H+1 WAL
      // record retains the pre-apply runtime input while its durable outbox
      // already contains deferred H+2.
      runtimeInput: structuredClone(runtimeMachineBeforeHeightOne['runtimeInput']),
    };
    const journal: PersistedFrameJournal = {
      height: committedHistoryFrame.height,
      timestamp: committedHistoryFrame.timestamp,
      replicaMetaDigest: buildStorageReplicaMetaCommitment(restarted).digest,
      runtimeInput: structuredClone(committedHistoryFrame.runtimeInput),
      runtimeOutputs: structuredClone(restarted.pendingNetworkOutputs ?? []),
      runtimeMachineBeforeApply: runtimeMachineBeforeHeightOne,
      runtimeMachine: durableMachineAfterHeightOne,
      runtimeStateHash: computeCanonicalRuntimeStateHash(
        restarted.height,
        restarted.timestamp,
        computeCanonicalEntityHashesFromEnv(restarted),
        durableMachineAfterHeightOne,
      ),
      logs: structuredClone(committedHistoryFrame.logs ?? []),
    };
    const tailRecoveryBundle = buildRuntimeRecoveryBundle(restarted, {
      signers: recoverySigners,
      kind: 'journal_tail',
      baseCheckpoint: {
        height: baseRecoveryBundle.runtimeHeight,
        hash: baseRecoveryBundle.checkpointHash!,
      },
      frames: [journal],
      createdAt: 1_001,
    });
    // A recovery process owns this runtime namespace exclusively. Close the
    // first restore's infra handle before simulating the next process; opening
    // two Level instances for one path correctly fails instead of sharing an
    // unsafe writer.
    await closeInfraDb(restarted);
    const tailRestored = await restoreEnvFromRecoveryBundles(
      [baseRecoveryBundle, tailRecoveryBundle],
      { runtimeSeed: receiverSeed, runtimeId: receiver.runtimeId },
    );
    expect(safeStringify(reliableRecoveryProjection(tailRestored))).toBe(
      safeStringify(reliableRecoveryProjection(restarted)),
    );
    expect(computeCanonicalStateHashFromEnv(tailRestored)).toBe(journal.runtimeStateHash);
    await closeInfraDb(tailRestored);

    const missingPreStateTail = structuredClone(tailRecoveryBundle);
    delete missingPreStateTail.frames![0]!.runtimeMachineBeforeApply;
    await expect(restoreEnvFromRecoveryBundles(
      [baseRecoveryBundle, missingPreStateTail],
      { runtimeSeed: receiverSeed, runtimeId: receiver.runtimeId },
    )).rejects.toThrow('RECOVERY_BUNDLE_JOURNAL_PRE_RUNTIME_MACHINE_REQUIRED');

    const missingLocalOutboxTail = structuredClone(tailRecoveryBundle);
    missingLocalOutboxTail.frames![0]!.runtimeMachineBeforeApply = {
      ...missingLocalOutboxTail.frames![0]!.runtimeMachineBeforeApply,
      pendingNetworkOutputs: [],
    };
    await expect(restoreEnvFromRecoveryBundles(
      [baseRecoveryBundle, missingLocalOutboxTail],
      { runtimeSeed: receiverSeed, runtimeId: receiver.runtimeId },
    )).rejects.toThrow('RECOVERY_BUNDLE_SIGNATURE_INVALID');

    const corruptTail = structuredClone(tailRecoveryBundle);
    corruptTail.frames![0]!.runtimeStateHash = `0x${'00'.repeat(32)}`;
    await expect(restoreEnvFromRecoveryBundles(
      [baseRecoveryBundle, corruptTail],
      { runtimeSeed: receiverSeed, runtimeId: receiver.runtimeId },
    )).rejects.toThrow('RECOVERY_BUNDLE_SIGNATURE_INVALID');

    const afterHeightOneSnapshot = buildDurableRuntimeMachineSnapshot(restarted);
    const afterHeightOneRestart = createRuntime(receiverSeed);
    afterHeightOneRestart.eReplicas.set(
      `${initialState.entityId}:${signerId}`,
      structuredClone(afterHeightOneReplica!),
    );
    afterHeightOneRestart.eReplicas.get(`${initialState.entityId}:${signerId}`)!.isProposer = false;
    restoreDurableRuntimeSnapshot(afterHeightOneRestart, afterHeightOneSnapshot);

    for (let tick = 0; tick < 8; tick += 1) {
      await processRuntime(afterHeightOneRestart, []);
      const replica = afterHeightOneRestart.eReplicas.get(`${initialState.entityId}:${signerId}`);
      if (
        replica?.state.height === 2 &&
        replica.state.prevFrameHash === heightTwo.frame.hash &&
        (afterHeightOneRestart.pendingNetworkOutputs?.length ?? 0) === 0 &&
        (afterHeightOneRestart.runtimeMempool?.reliableReceipts?.length ?? 0) === 0
      ) break;
    }

    const finalReplica = afterHeightOneRestart.eReplicas.get(`${initialState.entityId}:${signerId}`);
    expect(finalReplica?.state.height).toBe(2);
    expect(finalReplica?.state.prevFrameHash).toBe(heightTwo.frame.hash);
    expect(afterHeightOneRestart.pendingNetworkOutputs, safeStringify({
      pendingNetworkOutputs: afterHeightOneRestart.pendingNetworkOutputs,
      runtimeMempool: afterHeightOneRestart.runtimeMempool,
      pendingReliableIngress: afterHeightOneRestart.runtimeState?.pendingReliableIngress,
      reliableIngressReceiptLedger: afterHeightOneRestart.runtimeState?.reliableIngressReceiptLedger,
      reliableIngressTerminalWatermarks: afterHeightOneRestart.runtimeState?.reliableIngressTerminalWatermarks,
      receivedReliableReceiptLedger: afterHeightOneRestart.runtimeState?.receivedReliableReceiptLedger,
      receivedReliableTerminalWatermarks: afterHeightOneRestart.runtimeState?.receivedReliableTerminalWatermarks,
    }, 2)).toEqual([]);
    expect(afterHeightOneRestart.runtimeMempool?.entityInputs ?? []).toEqual([]);
    expect(afterHeightOneRestart.runtimeState?.reliableIngressTerminalWatermarks?.size).toBe(1);
    expect(afterHeightOneRestart.runtimeState?.receivedReliableTerminalWatermarks?.size).toBe(1);
  });
});
