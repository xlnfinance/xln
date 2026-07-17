import { describe, expect, test } from 'bun:test';
import { SigningKey, computeAddress, zeroPadValue } from 'ethers';

import {
  clearSignerKeys,
  deriveSignerKeySync,
  registerSignerKey,
  signAccountFrame,
  signDigestBytesWithPrivateKey,
} from '../account/crypto';
import { encodeBoard, generateLazyEntityId, generateNumberedEntityId, hashBoard } from '../entity/factory';
import { applyEntityInput, selectProposableEntityTxs } from '../entity/consensus';
import {
  buildConsensusOutputOriginForState,
  hashCertifiedEntityOutputSemantic,
  normalizeConsensusOutputBoardAuthority,
  resolveConsensusOutputBoardAuthority,
} from '../entity/consensus/output-certification';
import { buildQuorumHanko, verifyHankoForHash } from '../hanko/signing';
import { encodeSignedHanko } from '../hanko/codec';
import { hashHankoBoardClaim, resolveHankoBoardDelays } from '../hanko/claims';
import {
  applyCertifiedBoardRegistryEvent,
  advanceCertifiedBoardFinality,
  cacheCertifiedBoardNodes,
  createCertifiedBoardProof,
  getCertifiedBoardNodeStore,
  getCertifiedBoardStackKey,
  getCertifiedBoardEntityKey,
  hashCertifiedBoardNode,
  hashCertifiedBoardRecord,
  lookupCertifiedBoardRecord,
  EMPTY_CERTIFIED_BOARD_ROOT,
  putCertifiedBoardRecord,
  resolveObserverCertifiedBoardHash,
  resolveObserverCertifiedBoardRecord,
  resolveUniqueCertifiedRegisteredBoardRecord,
  verifyCertifiedBoardProof,
} from '../jurisdiction/board-registry';
import { deriveEncryptionKeyPair, pubKeyToHex } from '../networking/p2p-crypto';
import { computeProfileHash, signProfileRuntimeRoute, verifyProfileSignature } from '../networking/profile-signing';
import type { Profile } from '../networking/gossip';
import { computeValidatorEncryptionAttestationDigest } from '../protocol/htlc/validator-encryption';
import { canonicalJurisdictionEventsHash } from '../jurisdiction/event-observation';
import { getJEventJurisdictionRef } from '../jurisdiction/event-observation';
import { foldJHistoryRoot, EMPTY_J_HISTORY_ROOT } from '../jurisdiction/history-consensus';
import { buildLocalJPrefixAttestation } from '../jurisdiction/j-prefix-consensus';
import { recordValidatorJHistory } from '../jurisdiction/local-history';
import { createEmptyEnv, restoreEnvFromCheckpointSnapshot } from '../runtime';
import { getReliableOutputIdentity } from '../machine/output-routing';
import { createDueScheduledWakeInputs, refreshScheduledWakeIndex } from '../machine/scheduled-wake';
import { buildRuntimeCheckpointSnapshot } from '../wal/snapshot';
import { cloneEntityState } from '../state-helpers';
import type {
  ConsensusOutputOrigin,
  EntityReplica,
  EntityTx,
  Env,
  EntityState,
  JurisdictionConfig,
  JurisdictionEvent,
  RoutedEntityInput,
} from '../types';
import { addr, entity, makeAccount, makeState } from './helpers/cross-j';
import { buildJEventRangeData } from './helpers/j-history';

const hex = (bytes: Uint8Array): string => `0x${Buffer.from(bytes).toString('hex')}`;
const entityProviderAddress = addr('e1');
const depositoryAddress = addr('d1');
const jurisdiction = {
  name: 'Certified registry',
  address: 'http://127.0.0.1:8545',
  chainId: 31_337,
  depositoryAddress,
  entityProviderAddress,
  entityProviderDeploymentBlock: 1,
  registrationBlock: 2,
} satisfies JurisdictionConfig;
const registeredEntityId = generateNumberedEntityId(2).toLowerCase();
const blockHash = (byte: string): string => `0x${byte.repeat(32)}`;

const genericOutputIdentity = (
  sourceEntityId: string,
  targetEntityId: string,
  sequence: bigint,
  entityTxs: EntityTx[],
): Pick<ConsensusOutputOrigin, 'lane' | 'sequence' | 'semanticHash'> => ({
  lane: 'generic',
  sequence,
  semanticHash: hashCertifiedEntityOutputSemantic(
    sourceEntityId,
    targetEntityId,
    'generic',
    sequence,
    entityTxs,
  ),
});

const event = (
  type: 'FoundationBootstrapped' | 'EntityRegistered' | 'BoardActivated',
  boardHash: string,
  options: {
    entityId?: string;
    height?: number;
    logIndex?: number;
    previousBoardHash?: string;
    previousBoardValidUntil?: number;
  } = {},
): JurisdictionEvent => {
  const height = options.height ?? (type === 'FoundationBootstrapped' ? 1 : 2);
  const logIndex = options.logIndex ?? 0;
  const common = {
    blockNumber: height,
    blockHash: blockHash(height.toString(16).padStart(2, '0')),
    transactionHash: blockHash((height + logIndex + 32).toString(16).padStart(2, '0')),
    logIndex,
  };
  if (type === 'FoundationBootstrapped') return {
    type,
    data: { recipient: addr('f1'), boardHash, controlTokenId: '2', dividendTokenId: '3' },
    ...common,
  };
  const entityId = options.entityId ?? registeredEntityId;
  if (type === 'EntityRegistered') return {
    type,
    data: { entityId, entityNumber: BigInt(entityId).toString(), boardHash },
    ...common,
  };
  return {
    type,
    data: {
      entityId,
      previousBoardHash: options.previousBoardHash ?? blockHash('32'),
      newBoardHash: boardHash,
      previousBoardValidUntil: String(options.previousBoardValidUntil ?? 1_700_604_800),
    },
    ...common,
  };
};

const installEvents = (
  env: Env,
  state: EntityState,
  events: JurisdictionEvent[],
): void => {
  for (const item of events) {
    const applied = applyCertifiedBoardRegistryEvent(
      state.certifiedBoardState,
      getCertifiedBoardNodeStore(env),
      jurisdiction,
      item,
    );
    cacheCertifiedBoardNodes(env, applied.newNodes);
    state.certifiedBoardState = applied.state;
  }
};

const certifyEventPrefix = (
  state: EntityState,
  events: JurisdictionEvent[],
): void => {
  const jurisdictionRef = getJEventJurisdictionRef(state.config.jurisdiction);
  let eventHistoryRoot = EMPTY_J_HISTORY_ROOT;
  state.jBlockChain = events.map((item) => {
    const eventsHash = canonicalJurisdictionEventsHash([item]);
    const block = {
      jurisdictionRef,
      jHeight: item.blockNumber,
      jBlockHash: item.blockHash,
      eventsHash,
      events: [item],
      finalizedAt: 1,
      proposerSignerId: addr('77'),
      proposerSignature: blockHash('f1'),
    };
    eventHistoryRoot = foldJHistoryRoot(eventHistoryRoot, [block]);
    return block;
  });
  const last = events.at(-1)!;
  state.lastFinalizedJHeight = last.blockNumber;
  state.jHistoryFinality = {
    jurisdictionRef,
    baseHeight: 0,
    finalizedThroughHeight: last.blockNumber,
    tipBlockHash: last.blockHash,
    eventHistoryRoot,
    proposerSignerId: addr('77'),
    proposerSignature: blockHash('f1'),
    entityHeight: 1,
  };
  state.certifiedBoardState = {
    ...state.certifiedBoardState!,
    finalizedJHeight: last.blockNumber,
    finalizedJBlockHash: last.blockHash,
    eventHistoryRoot,
  };
};

const jRangeTx = (from: string, events: JurisdictionEvent[]): EntityTx => {
  const byHeight = new Map<number, JurisdictionEvent[]>();
  for (const item of events) {
    const blockEvents = byHeight.get(item.blockNumber) ?? [];
    blockEvents.push(item);
    byHeight.set(item.blockNumber, blockEvents);
  }
  const blocks = [...byHeight.entries()]
    .sort(([left], [right]) => left - right)
    .map(([blockNumber, blockEvents]) => ({
      blockNumber,
      blockHash: blockEvents[0]!.blockHash,
      eventsHash: canonicalJurisdictionEventsHash(blockEvents),
      events: blockEvents,
    }));
  const scannedThroughHeight = blocks.at(-1)!.blockNumber;
  return {
    type: 'j_event',
    data: {
      from,
      jurisdictionRef: blockHash('f0'),
      baseHeight: 0,
      scannedThroughHeight,
      tipBlockHash: blocks.at(-1)!.blockHash,
      eventHistoryRoot: blockHash('f2'),
      rangeHash: blockHash('f3'),
      blocks,
      observedAt: scannedThroughHeight,
      signature: blockHash('f4'),
    },
  };
};

const signDigest = (privateKey: Uint8Array, digest: string): string => {
  const signed = signDigestBytesWithPrivateKey(privateKey, Buffer.from(digest.slice(2), 'hex'));
  return `${hex(signed.signature)}${signed.recovery.toString(16).padStart(2, '0')}`;
};

const buildRegisteredProfile = async (): Promise<{
  profile: Profile;
  localEnv: Env;
  boardHash: string;
  privateKey: Uint8Array;
}> => {
  const privateKey = deriveSignerKeySync('registered-board-authority', '1');
  const publicKey = new SigningKey(hex(privateKey)).publicKey.toLowerCase();
  const signer = computeAddress(publicKey).toLowerCase();
  const encryptionPublicKey = pubKeyToHex(
    deriveEncryptionKeyPair(`${hex(privateKey)}:${registeredEntityId}:profile`).publicKey,
  );
  const attestationBody = {
    version: 'xln:validator-encryption-key:v1' as const,
    entityId: registeredEntityId,
    signerId: signer,
    signer,
    publicKey,
    weight: 1,
    encryptionPublicKey,
  };
  const config = {
    mode: 'proposer-based' as const,
    threshold: 1n,
    validators: [signer],
    shares: { [signer]: 1n },
    jurisdiction,
  };
  const state = makeState(registeredEntityId, signer, jurisdiction);
  state.config = config;
  const localEnv = createEmptyEnv('registered-board-authority:local');
  localEnv.runtimeSeed = 'registered-board-authority:runtime';
  localEnv.eReplicas.set(`${registeredEntityId}:${signer}`, {
    entityId: registeredEntityId,
    signerId: signer,
    state,
    mempool: [],
    isProposer: true,
  } as EntityReplica);
  const boardHash = hashBoard(encodeBoard(config)).toLowerCase();
  installEvents(localEnv, state, [event('FoundationBootstrapped', blockHash('31')), event('EntityRegistered', boardHash)]);
  registerSignerKey(localEnv, signer, privateKey);
  const profile: Profile = {
    entityId: registeredEntityId,
    name: 'Registered remote',
    avatar: '', bio: '', website: '', lastUpdated: 1,
    runtimeId: signer,
    runtimeEncPubKey: encryptionPublicKey,
    publicAccounts: [], wsUrl: null, relays: [],
    metadata: {
      isHub: true,
      routingFeePPM: 1,
      baseFee: 0n,
      jurisdiction: {
        name: jurisdiction.name,
        chainId: jurisdiction.chainId,
        depositoryAddress,
        entityProviderAddress,
      },
      board: {
        threshold: 1,
        validators: [{ signer, signerId: signer, publicKey, weight: 1 }],
        encryptionAttestations: [{
          ...attestationBody,
          signature: signDigest(privateKey, computeValidatorEncryptionAttestationDigest(attestationBody)),
        }],
      },
    },
    accounts: [],
  };
  const profileHash = computeProfileHash(profile);
  profile.metadata.profileHanko = await buildQuorumHanko(
    localEnv,
    registeredEntityId,
    profileHash,
    [{ signerId: signer, signature: signDigest(privateKey, profileHash) }],
    config,
  );
  return { profile: await signProfileRuntimeRoute(localEnv, profile, signer), localEnv, boardHash, privateKey };
};

const remoteObserverEnv = (boardHash: string): Env => {
  const env = createEmptyEnv('registered-board-authority:remote');
  const signerId = addr('91');
  const state = makeState(entity('99'), signerId, jurisdiction);
  installEvents(env, state, [event('FoundationBootstrapped', blockHash('31')), event('EntityRegistered', boardHash)]);
  env.eReplicas.set(`${state.entityId}:${signerId}`, {
    entityId: state.entityId, signerId, state, mempool: [], isProposer: true,
  } as EntityReplica);
  return env;
};

describe('registered Entity certified board authority', () => {
  test('certified output origin cannot omit its source board authority', () => {
    const env = createEmptyEnv('registry-output-origin');
    const state = makeState(registeredEntityId, addr('77'), jurisdiction);
    installEvents(env, state, [
      event('FoundationBootstrapped', blockHash('31')),
      event('EntityRegistered', blockHash('32')),
    ]);
    state.lastFinalizedJHeight = 2;
    state.certifiedBoardState = {
      ...state.certifiedBoardState!,
      finalizedJHeight: 2,
      finalizedJBlockHash: blockHash('02'),
      eventHistoryRoot: blockHash('92'),
    };
    state.jHistoryFinality = {
      jurisdictionRef: blockHash('93'),
      baseHeight: 0,
      finalizedThroughHeight: 2,
      tipBlockHash: blockHash('02'),
      eventHistoryRoot: blockHash('92'),
      proposerSignerId: addr('77'),
      proposerSignature: blockHash('94'),
      entityHeight: 1,
    };
    const outputTxs: EntityTx[] = [{
      type: 'chat',
      data: { from: registeredEntityId, message: 'certified authority' },
    }];
    const targetEntityId = entity('a2');
    const origin = buildConsensusOutputOriginForState(
      state,
      env,
      7,
      blockHash('a1'),
      0,
      genericOutputIdentity(state.entityId, targetEntityId, 1n, outputTxs),
    );
    expect(origin.boardAuthority).toEqual({
      version: 4,
      stackKey: state.certifiedBoardState.stackKey,
      record: expect.objectContaining({
        entityId: registeredEntityId,
        boardHash: blockHash('32'),
        boardEpoch: 0,
        activatedAtJHeight: 2,
      }),
    });
    const partial = structuredClone(origin.boardAuthority!);
    delete (partial.record as Partial<typeof partial.record>).transactionHash;
    expect(() => normalizeConsensusOutputBoardAuthority(partial, registeredEntityId))
      .toThrow('CONSENSUS_OUTPUT_BOARD_TRANSACTION_HASH_INVALID');
  });

  test('registered output defers before exact J-prefix and verifies after catch-up', () => {
    const oldBoard = blockHash('32');
    const newBoard = blockHash('33');
    const previousBoardValidUntil = 1_700_604_800;
    const prefix = [
      event('FoundationBootstrapped', blockHash('31')),
      event('EntityRegistered', oldBoard),
    ];
    const rotation = event('BoardActivated', newBoard, {
      height: 3,
      logIndex: 0,
      previousBoardValidUntil,
    });

    const sourceEnv = createEmptyEnv('registry-output-source');
    const source = makeState(registeredEntityId, addr('77'), jurisdiction);
    installEvents(sourceEnv, source, prefix);
    certifyEventPrefix(source, prefix);
    const targetEntityId = entity('a3');
    const oldOutputTxs: EntityTx[] = [{
      type: 'chat',
      data: { from: registeredEntityId, message: 'before rotation' },
    }];
    const oldOrigin = buildConsensusOutputOriginForState(
      source,
      sourceEnv,
      8,
      blockHash('a8'),
      0,
      genericOutputIdentity(source.entityId, targetEntityId, 1n, oldOutputTxs),
    );
    installEvents(sourceEnv, source, [rotation]);
    certifyEventPrefix(source, [...prefix, rotation]);
    const outputTxs: EntityTx[] = [{
      type: 'chat',
      data: { from: registeredEntityId, message: 'after rotation' },
    }];
    const origin = buildConsensusOutputOriginForState(
      source,
      sourceEnv,
      9,
      blockHash('a9'),
      0,
      genericOutputIdentity(source.entityId, targetEntityId, 2n, outputTxs),
    );

    const observerEnv = createEmptyEnv('registry-output-observer');
    const observer = makeState(entity('77'), addr('78'), jurisdiction);
    installEvents(observerEnv, observer, prefix);
    certifyEventPrefix(observer, prefix);
    expect(resolveConsensusOutputBoardAuthority(oldOrigin, observer, observerEnv)).toEqual({
      kind: 'registered',
      record: expect.objectContaining({ entityId: registeredEntityId, boardHash: oldBoard }),
    });
    expect(resolveConsensusOutputBoardAuthority(origin, observer, observerEnv)).toEqual({
      kind: 'defer',
      requiredJHeight: 3,
      observerJHeight: 2,
    });

    installEvents(observerEnv, observer, [rotation]);
    certifyEventPrefix(observer, [...prefix, rotation]);
    observer.timestamp = previousBoardValidUntil * 1_000 - 1;
    expect(resolveConsensusOutputBoardAuthority(oldOrigin, observer, observerEnv)).toEqual({
      kind: 'registered',
      record: expect.objectContaining({
        entityId: registeredEntityId,
        boardHash: newBoard,
        previousBoardHash: oldBoard,
        previousBoardValidUntil,
      }),
    });
    observer.timestamp = previousBoardValidUntil * 1_000;
    expect(() => resolveConsensusOutputBoardAuthority(oldOrigin, observer, observerEnv))
      .toThrow('CONSENSUS_OUTPUT_BOARD_AUTHORITY_STALE');
    expect(resolveConsensusOutputBoardAuthority(origin, observer, observerEnv)).toEqual({
      kind: 'registered',
      record: expect.objectContaining({ entityId: registeredEntityId, boardHash: newBoard }),
    });

    for (let offset = 1; offset <= 1_000; offset += 1) {
      const height = 3 + offset;
      const tipBlockHash = `0x${height.toString(16).padStart(64, '0')}`;
      observer.lastFinalizedJHeight = height;
      observer.jHistoryFinality = {
        ...observer.jHistoryFinality!,
        baseHeight: height - 1,
        finalizedThroughHeight: height,
        tipBlockHash,
      };
      observer.certifiedBoardState = advanceCertifiedBoardFinality(
        observer.certifiedBoardState,
        jurisdiction,
        height,
        tipBlockHash,
        observer.jHistoryFinality.eventHistoryRoot,
      );
      observer.jBlockChain = [];
    }
    expect(resolveConsensusOutputBoardAuthority(origin, observer, observerEnv)).toEqual({
      kind: 'registered',
      record: expect.objectContaining({ entityId: registeredEntityId, boardHash: newBoard }),
    });

    const conflicting = structuredClone(origin);
    conflicting.boardAuthority!.record.transactionHash = blockHash('ee');
    expect(() => resolveConsensusOutputBoardAuthority(conflicting, observer, observerEnv))
      .toThrow('CONSENSUS_OUTPUT_BOARD_RECORD_CONFLICT');
  });

  test('previous-board grace accepts only the adjacent epoch across A to B to A rotations', () => {
    const boardA = blockHash('32');
    const boardB = blockHash('33');
    const boardC = blockHash('34');
    const previousBoardValidUntil = 1_700_604_800;
    const prefix = [
      event('FoundationBootstrapped', blockHash('31')),
      event('EntityRegistered', boardA),
    ];
    const rotateToB = event('BoardActivated', boardB, {
      height: 3,
      previousBoardHash: boardA,
      previousBoardValidUntil,
    });
    const rotateBackToA = event('BoardActivated', boardA, {
      height: 4,
      previousBoardHash: boardB,
      previousBoardValidUntil,
    });
    const rotateToC = event('BoardActivated', boardC, {
      height: 5,
      previousBoardHash: boardA,
      previousBoardValidUntil,
    });
    const targetEntityId = entity('a4');
    const sourceEnv = createEmptyEnv('registry-output-epoch-adjacency-source');
    const source = makeState(registeredEntityId, addr('77'), jurisdiction);
    installEvents(sourceEnv, source, prefix);
    certifyEventPrefix(source, prefix);
    const epochZeroTxs: EntityTx[] = [{
      type: 'chat',
      data: { from: registeredEntityId, message: 'epoch zero' },
    }];
    const epochZeroOrigin = buildConsensusOutputOriginForState(
      source,
      sourceEnv,
      7,
      blockHash('a7'),
      0,
      genericOutputIdentity(source.entityId, targetEntityId, 1n, epochZeroTxs),
    );
    installEvents(sourceEnv, source, [rotateToB, rotateBackToA]);
    certifyEventPrefix(source, [...prefix, rotateToB, rotateBackToA]);
    const epochTwoTxs: EntityTx[] = [{
      type: 'chat',
      data: { from: registeredEntityId, message: 'epoch two' },
    }];
    const epochTwoOrigin = buildConsensusOutputOriginForState(
      source,
      sourceEnv,
      8,
      blockHash('a8'),
      0,
      genericOutputIdentity(source.entityId, targetEntityId, 2n, epochTwoTxs),
    );
    expect(epochZeroOrigin.boardAuthority?.record.boardEpoch).toBe(0);
    expect(epochTwoOrigin.boardAuthority?.record.boardEpoch).toBe(2);

    const observerEnv = createEmptyEnv('registry-output-epoch-adjacency-observer');
    const observer = makeState(entity('78'), addr('78'), jurisdiction);
    installEvents(observerEnv, observer, [...prefix, rotateToB, rotateBackToA, rotateToC]);
    certifyEventPrefix(observer, [...prefix, rotateToB, rotateBackToA, rotateToC]);
    observer.timestamp = previousBoardValidUntil * 1_000 - 1;
    expect(resolveConsensusOutputBoardAuthority(epochTwoOrigin, observer, observerEnv)).toEqual({
      kind: 'registered',
      record: expect.objectContaining({ boardHash: boardC, boardEpoch: 3 }),
    });
    expect(() => resolveConsensusOutputBoardAuthority(epochZeroOrigin, observer, observerEnv))
      .toThrow('CONSENSUS_OUTPUT_BOARD_AUTHORITY_STALE');
  });

  test('ahead registered output stays durable without mutating the receiver', async () => {
    const sourceEnv = createEmptyEnv('registry-output-durable-source');
    const source = makeState(registeredEntityId, addr('77'), jurisdiction);
    const prefix = [
      event('FoundationBootstrapped', blockHash('31')),
      event('EntityRegistered', blockHash('32')),
    ];
    const rotation = event('BoardActivated', blockHash('33'), { height: 3 });
    installEvents(sourceEnv, source, [...prefix, rotation]);
    certifyEventPrefix(source, [...prefix, rotation]);

    const receiverPrivateKey = deriveSignerKeySync('registry-output-durable-receiver', '1');
    const receiverSigner = computeAddress(new SigningKey(hex(receiverPrivateKey)).publicKey).toLowerCase();
    const receiverEntityId = generateLazyEntityId([receiverSigner], 1n).toLowerCase();
    const outputTxs: EntityTx[] = [{
      type: 'chat',
      data: { from: registeredEntityId, message: 'after rotation' },
    }];
    const origin = buildConsensusOutputOriginForState(
      source,
      sourceEnv,
      9,
      blockHash('a9'),
      0,
      genericOutputIdentity(source.entityId, receiverEntityId, 1n, outputTxs),
    );
    const receiverEnv = createEmptyEnv('registry-output-durable-receiver');
    registerSignerKey(receiverEnv, receiverSigner, receiverPrivateKey);
    receiverEnv.runtimeSeed = 'registry-output-durable-receiver';
    receiverEnv.timestamp = 10;
    receiverEnv.scenarioMode = true;
    receiverEnv.quietRuntimeLogs = true;
    const receiver = makeState(receiverEntityId, receiverSigner, jurisdiction);
    installEvents(receiverEnv, receiver, prefix);
    certifyEventPrefix(receiver, prefix);
    const replica = {
      entityId: receiverEntityId,
      signerId: receiverSigner,
      state: receiver,
      mempool: [],
      isProposer: true,
    } as EntityReplica;
    const initialHeight = receiver.height;
    const initialMessages = structuredClone(receiver.messages);

    const result = await applyEntityInput(receiverEnv, replica, {
      entityId: receiverEntityId,
      signerId: receiverSigner,
      entityTxs: [{
        type: 'consensusOutput',
        data: {
          origin,
          outputHanko: '0x01',
          targetEntityId: receiverEntityId,
          entityTxs: outputTxs,
        },
      }],
    });
    expect(result.outcome).toEqual({ kind: 'committed' });
    expect(result.workingReplica.state.height).toBe(initialHeight);
    expect(result.workingReplica.state.messages).toEqual(initialMessages);
    expect(result.workingReplica.mempool.map((tx) => tx.type)).toEqual(['consensusOutput']);
    expect(result.outputs).toEqual([]);
  });

  test('proposal gate requires exact registration/rotation handover before other work', async () => {
    const env = createEmptyEnv('registry-board-handover');
    env.runtimeSeed = 'registry-board-handover';
    const keyA = deriveSignerKeySync('registry-board-handover', '1');
    const keyB = deriveSignerKeySync('registry-board-handover', '2');
    const signerA = computeAddress(new SigningKey(hex(keyA)).publicKey).toLowerCase();
    const signerB = computeAddress(new SigningKey(hex(keyB)).publicKey).toLowerCase();
    registerSignerKey(env, signerA, keyA);
    registerSignerKey(env, signerB, keyB);
    const oldConfig = {
      mode: 'proposer-based' as const,
      threshold: 2n,
      validators: [signerA, signerB],
      shares: { [signerA]: 1n, [signerB]: 1n },
      jurisdiction,
    };
    const newConfig = {
      ...oldConfig,
      threshold: 3n,
      shares: { [signerA]: 2n, [signerB]: 1n },
    };
    const oldBoard = hashBoard(encodeBoard(oldConfig)).toLowerCase();
    const newBoard = hashBoard(encodeBoard(newConfig)).toLowerCase();
    const foundation = event('FoundationBootstrapped', blockHash('31'));
    const registration = event('EntityRegistered', oldBoard);
    const rotation = event('BoardActivated', newBoard, { height: 3, previousBoardHash: oldBoard });
    const profileTx = { type: 'chat', data: { from: signerA, message: 'must wait' } } satisfies EntityTx;

    const pending = makeState(registeredEntityId, signerA, jurisdiction);
    pending.config = oldConfig;
    expect(await selectProposableEntityTxs(
      env,
      pending,
      [profileTx, jRangeTx(signerA, [foundation, registration])],
    )).toEqual({
      txs: [expect.objectContaining({ type: 'j_event' })],
      currentAuthorityReady: false,
      reason: 'SELF_BOARD_BOOTSTRAP_PRIORITY',
    });
    expect(await selectProposableEntityTxs(env, pending, [profileTx])).toEqual({
      txs: [],
      currentAuthorityReady: false,
      reason: 'SELF_BOARD_CERTIFICATION_REQUIRED',
    });

    const oldState = makeState(registeredEntityId, signerA, jurisdiction);
    oldState.config = oldConfig;
    installEvents(env, oldState, [foundation, registration]);
    certifyEventPrefix(oldState, [foundation, registration]);
    expect(await selectProposableEntityTxs(env, oldState, [jRangeTx(signerA, [rotation])])).toEqual({
      txs: [],
      currentAuthorityReady: true,
      reason: 'SELF_BOARD_CONFIG_HANDOVER_REQUIRED',
    });

    const updatedA = cloneEntityState(oldState);
    const updatedB = cloneEntityState(oldState);
    updatedA.config = newConfig;
    updatedB.config = newConfig;
    for (const updated of [updatedA, updatedB]) {
      const selection = await selectProposableEntityTxs(env, updated, [jRangeTx(signerA, [rotation]), profileTx]);
      expect(selection.currentAuthorityReady).toBe(false);
      expect(selection.reason).toBe('SELF_BOARD_BOOTSTRAP_PRIORITY');
      expect(selection.txs.map((tx) => tx.type)).toEqual(['j_event']);
    }
  });

  test('partial board config cannot precommit rotation; synchronized validators commit it', async () => {
    const env = createEmptyEnv('registry-board-handover-consensus');
    env.runtimeSeed = 'registry-board-handover-consensus';
    env.timestamp = 100;
    env.scenarioMode = true;
    env.quietRuntimeLogs = true;
    const keyA = deriveSignerKeySync('registry-board-handover-consensus', '1');
    const keyB = deriveSignerKeySync('registry-board-handover-consensus', '2');
    const keyC = deriveSignerKeySync('registry-board-handover-consensus', '3');
    const signerA = computeAddress(new SigningKey(hex(keyA)).publicKey).toLowerCase();
    const signerB = computeAddress(new SigningKey(hex(keyB)).publicKey).toLowerCase();
    const signerC = computeAddress(new SigningKey(hex(keyC)).publicKey).toLowerCase();
    registerSignerKey(env, signerA, keyA);
    registerSignerKey(env, signerB, keyB);
    registerSignerKey(env, signerC, keyC);
    const oldConfig = {
      mode: 'proposer-based' as const,
      threshold: 2n,
      validators: [signerA, signerB],
      shares: { [signerA]: 1n, [signerB]: 1n },
      jurisdiction,
    };
    const newConfig = {
      ...oldConfig,
      threshold: 3n,
      shares: { [signerA]: 2n, [signerB]: 1n },
    };
    const oldBoard = hashBoard(encodeBoard(oldConfig)).toLowerCase();
    const newBoard = hashBoard(encodeBoard(newConfig)).toLowerCase();
    const foundation = event('FoundationBootstrapped', blockHash('31'));
    const registration = event('EntityRegistered', oldBoard);
    const rotation = event('BoardActivated', newBoard, { height: 3, previousBoardHash: oldBoard });
    const baseState = makeState(registeredEntityId, signerA, jurisdiction);
    baseState.config = oldConfig;
    baseState.prevFrameHash = blockHash('aa');
    baseState.leaderState = { activeValidatorId: signerA, view: 0, changedAtHeight: 0 };
    installEvents(env, baseState, [foundation, registration]);
    certifyEventPrefix(baseState, [foundation, registration]);
    const counterpartyEntityId = generateLazyEntityId([signerC], 1n).toLowerCase();
    const counterpartyState = makeState(counterpartyEntityId, signerC, jurisdiction);
    env.eReplicas.set(`${counterpartyEntityId}:${signerC}`, {
      entityId: counterpartyEntityId,
      signerId: signerC,
      state: counterpartyState,
      mempool: [],
      isProposer: true,
    });
    const certifiedFrameHash = blockHash('d1');
    const certifiedDisputeHash = blockHash('d2');
    const certifiedProofBodyHash = blockHash('d3');
    const certifiedProofNonce = 4;
    const account = makeAccount(registeredEntityId, counterpartyEntityId, jurisdiction);
    account.currentHeight = 7;
    account.currentFrame = {
      ...account.currentFrame,
      height: 7,
      timestamp: 99,
      jHeight: 2,
      prevFrameHash: blockHash('d0'),
      stateHash: certifiedFrameHash,
      accountStateRoot: certifiedFrameHash,
    };
    account.currentFrameHanko = await buildQuorumHanko(env, registeredEntityId, certifiedFrameHash, [
      { signerId: signerA, signature: await signAccountFrame(env, signerA, certifiedFrameHash) },
      { signerId: signerB, signature: await signAccountFrame(env, signerB, certifiedFrameHash) },
    ], oldConfig, baseState);
    account.counterpartyFrameHanko = await buildQuorumHanko(env, counterpartyEntityId, certifiedFrameHash, [{
      signerId: signerC,
      signature: await signAccountFrame(env, signerC, certifiedFrameHash),
    }], counterpartyState.config, counterpartyState);
    account.currentDisputeHash = certifiedDisputeHash;
    account.currentDisputeProofBodyHash = certifiedProofBodyHash;
    account.currentDisputeProofNonce = certifiedProofNonce;
    account.currentDisputeProofHanko = await buildQuorumHanko(env, registeredEntityId, certifiedDisputeHash, [
      { signerId: signerA, signature: await signAccountFrame(env, signerA, certifiedDisputeHash) },
      { signerId: signerB, signature: await signAccountFrame(env, signerB, certifiedDisputeHash) },
    ], oldConfig, baseState);
    account.counterpartyDisputeHash = certifiedDisputeHash;
    account.counterpartyDisputeProofBodyHash = certifiedProofBodyHash;
    account.counterpartyDisputeProofNonce = certifiedProofNonce;
    account.counterpartyDisputeProofHanko = await buildQuorumHanko(
      env,
      counterpartyEntityId,
      certifiedDisputeHash,
      [{ signerId: signerC, signature: await signAccountFrame(env, signerC, certifiedDisputeHash) }],
      counterpartyState.config,
      counterpartyState,
    );
    account.jNonce = 3;
    baseState.accounts.set(counterpartyEntityId, account);
    const jurisdictionRef = getJEventJurisdictionRef(jurisdiction);
    const rotationData = buildJEventRangeData(baseState, {
      from: signerA,
      jurisdictionRef,
      event: rotation,
      observedAt: 3,
      blockNumber: 3,
      blockHash: rotation.blockHash,
    }, env);
    const rotationBlock = rotationData.blocks[0]!;
    const localHistory = recordValidatorJHistory(undefined, {
      jurisdictionRef,
      scannedThroughHeight: 3,
      tipBlockHash: rotation.blockHash,
      headers: [{ jHeight: 3, jBlockHash: rotation.blockHash }],
      blocks: [{
        jurisdictionRef,
        jHeight: 3,
        jBlockHash: rotationBlock.blockHash,
        eventsHash: rotationBlock.eventsHash,
        events: rotationBlock.events,
      }],
    }, baseState);

    const newProposerState = cloneEntityState(baseState);
    newProposerState.config = newConfig;
    const proposerReplica = {
      entityId: registeredEntityId,
      signerId: signerA,
      state: newProposerState,
      mempool: [],
      isProposer: true,
      jHistory: structuredClone(localHistory),
    } as EntityReplica;
    const validatorReplica = {
      entityId: registeredEntityId,
      signerId: signerB,
      state: cloneEntityState(newProposerState),
      mempool: [],
      isProposer: false,
      jHistory: structuredClone(localHistory),
    } as EntityReplica;
    const proposerJPrefix = buildLocalJPrefixAttestation(env, proposerReplica, proposerReplica.jHistory);
    const validatorJPrefix = buildLocalJPrefixAttestation(env, validatorReplica, validatorReplica.jHistory);
    if (!proposerJPrefix || !validatorJPrefix) {
      throw new Error('TEST_BOARD_ROTATION_J_PREFIX_ATTESTATION_MISSING');
    }
    const proposed = await applyEntityInput(env, proposerReplica, {
      entityId: registeredEntityId,
      signerId: signerA,
      entityTxs: [{ type: 'j_event', data: rotationData }],
      jPrefixAttestations: new Map([
        [signerA, proposerJPrefix],
        [signerB, validatorJPrefix],
      ]),
    });
    const proposal = proposed.workingReplica.proposal;
    if (!proposal) throw new Error('TEST_BOARD_ROTATION_PROPOSAL_MISSING');
    expect(proposal.txs.map((tx) => tx.type)).toEqual(['j_event']);
    expect(proposal.hashesToSign.some(entry => entry.hash === certifiedFrameHash)).toBe(false);
    expect(proposal.hashesToSign.some(entry => entry.hash === certifiedDisputeHash)).toBe(false);

    const oldValidatorState = cloneEntityState(baseState);
    oldValidatorState.config = oldConfig;
    const partial = await applyEntityInput(env, {
      entityId: registeredEntityId,
      signerId: signerB,
      state: oldValidatorState,
      mempool: [],
      isProposer: false,
      jHistory: structuredClone(localHistory),
    }, {
      entityId: registeredEntityId,
      signerId: signerB,
      proposedFrame: structuredClone(proposal),
    });
    expect(partial.outcome.kind).toBe('rejected');
    expect(partial.outputs.some((output) => output.hashPrecommits?.has(signerB))).toBe(false);
    expect(partial.workingReplica.state.height).toBe(baseState.height);

    const updatedValidatorState = cloneEntityState(baseState);
    updatedValidatorState.config = newConfig;
    const prepared = await applyEntityInput(env, {
      entityId: registeredEntityId,
      signerId: signerB,
      state: updatedValidatorState,
      mempool: [],
      isProposer: false,
      jHistory: structuredClone(localHistory),
    }, {
      entityId: registeredEntityId,
      signerId: signerB,
      proposedFrame: structuredClone(proposal),
    });
    const precommit = prepared.outputs.find((output) => output.hashPrecommits?.has(signerB));
    if (!precommit) throw new Error('TEST_BOARD_ROTATION_PRECOMMIT_MISSING');
    expect(precommit.hashPrecommits?.get(signerB)?.length).toBe(proposal.hashesToSign.length);
    const committed = await applyEntityInput(env, proposed.workingReplica, structuredClone(precommit));
    expect(committed.workingReplica.state.height).toBe(baseState.height + 1);
    expect(resolveObserverCertifiedBoardHash(
      committed.workingReplica.state,
      getCertifiedBoardNodeStore(env),
      registeredEntityId,
    )).toBe(newBoard);
    const committedAccount = committed.workingReplica.state.accounts.get(counterpartyEntityId);
    if (!committedAccount) throw new Error('TEST_BOARD_ROTATION_ACCOUNT_MISSING');
    expect(committedAccount.currentHeight).toBe(7);
    expect(committedAccount.currentFrame.stateHash).toBe(certifiedFrameHash);
    expect(committedAccount.jNonce).toBe(3);
    expect(committedAccount.currentDisputeHash).toBe(certifiedDisputeHash);
    expect(committedAccount.currentDisputeProofBodyHash).toBe(certifiedProofBodyHash);
    expect(committedAccount.currentDisputeProofNonce).toBe(certifiedProofNonce);
    expect(committedAccount.boardResealMigration).toEqual({
      activationJHeight: 3,
      activationLogIndex: 0,
      reason: 'pending',
    });
    expect(committed.workingReplica.state.crontabState?.hooks.get('board-reseal')).toMatchObject({
      id: 'board-reseal',
      type: 'board_reseal',
      data: {
        activationJHeight: 3,
        activationLogIndex: 0,
        afterCounterpartyId: '',
      },
    });

    env.eReplicas.set(`${registeredEntityId}:${signerA}`, committed.workingReplica);
    refreshScheduledWakeIndex(env, new Set([registeredEntityId]));
    const wakeValidatorReplica = {
      entityId: registeredEntityId,
      signerId: signerB,
      state: cloneEntityState(committed.workingReplica.state),
      mempool: [],
      isProposer: false,
      jHistory: structuredClone(localHistory),
    } as EntityReplica;
    const wakeProposerPrefix = buildLocalJPrefixAttestation(
      env,
      committed.workingReplica,
      committed.workingReplica.jHistory,
    );
    const wakeValidatorPrefix = buildLocalJPrefixAttestation(env, wakeValidatorReplica, wakeValidatorReplica.jHistory);
    if (!wakeProposerPrefix || !wakeValidatorPrefix) {
      throw new Error('TEST_BOARD_ROTATION_RESEAL_J_PREFIX_MISSING');
    }
    const wakeInput = createDueScheduledWakeInputs(env, committed.workingReplica.state.timestamp)
      .find(input => input.entityId.toLowerCase() === registeredEntityId);
    if (!wakeInput) throw new Error('TEST_BOARD_ROTATION_RESEAL_WAKE_MISSING');
    wakeInput.jPrefixAttestations = new Map([
      [signerA, wakeProposerPrefix],
      [signerB, wakeValidatorPrefix],
    ]);
    const wakeTx = wakeInput.entityTxs?.[0];
    if (!wakeTx || wakeTx.type !== 'scheduledWake') throw new Error('TEST_BOARD_RESEAL_SCHEDULED_WAKE_TX_MISSING');
    expect(wakeTx.data.jobs.some(job => job.kind === 'hook' && job.id === 'board-reseal')).toBe(true);
    const wakeProposed = await applyEntityInput(env, committed.workingReplica, wakeInput);
    const wakeProposal = wakeProposed.workingReplica.proposal;
    if (!wakeProposal) {
      throw new Error(
        `TEST_BOARD_ROTATION_RESEAL_PROPOSAL_MISSING:` +
        `outcome=${wakeProposed.outcome.kind}:outputs=${wakeProposed.outputs.length}:` +
        `height=${wakeProposed.workingReplica.state.height}:` +
        `marker=${wakeProposed.workingReplica.state.accounts.get(counterpartyEntityId)?.boardResealMigration?.reason ?? 'none'}:` +
        `hooks=${wakeProposed.workingReplica.state.crontabState?.hooks.size ?? -1}`,
      );
    }
    expect(wakeProposal.hashesToSign).toContainEqual(expect.objectContaining({
      hash: certifiedFrameHash,
      type: 'accountFrame',
    }));
    expect(wakeProposal.hashesToSign).toContainEqual(expect.objectContaining({
      hash: certifiedDisputeHash,
      type: 'dispute',
    }));
    // Validators replay the same committed Account with independent hosting
    // topologies. Recipient routing must remain derivable from its certified
    // counterparty Hanko after the target replica disappears locally.
    env.eReplicas.delete(`${counterpartyEntityId}:${signerC}`);
    expect([...env.eReplicas.values()].some(replica =>
      replica.state.entityId.toLowerCase() === counterpartyEntityId)).toBe(false);
    const wakePrepared = await applyEntityInput(env, {
      ...wakeValidatorReplica,
    }, {
      entityId: registeredEntityId,
      signerId: signerB,
      proposedFrame: structuredClone(wakeProposal),
    });
    const wakePrecommit = wakePrepared.outputs.find(output => output.hashPrecommits?.has(signerB));
    if (!wakePrecommit) throw new Error('TEST_BOARD_ROTATION_RESEAL_PRECOMMIT_MISSING');
    const resealCommitted = await applyEntityInput(env, wakeProposed.workingReplica, structuredClone(wakePrecommit));
    const resealedAccount = resealCommitted.workingReplica.state.accounts.get(counterpartyEntityId);
    if (!resealedAccount) throw new Error('TEST_BOARD_ROTATION_RESEALED_ACCOUNT_MISSING');
    expect(resealedAccount.boardResealMigration).toBeUndefined();
    const certifiedResealOutput = resealCommitted.outputs.find(output => output.entityTxs?.some(tx =>
      tx.type === 'consensusOutput' && tx.data.entityTxs.some(nested =>
        nested.type === 'accountInput' && nested.data.kind === 'board_reseal')));
    const certifiedReseal = certifiedResealOutput?.entityTxs?.find(tx =>
      tx.type === 'consensusOutput' && tx.data.entityTxs.some(nested =>
        nested.type === 'accountInput' && nested.data.kind === 'board_reseal'));
    if (!certifiedReseal || certifiedReseal.type !== 'consensusOutput') {
      throw new Error('TEST_BOARD_ROTATION_CERTIFIED_RESEAL_MISSING');
    }
    const nestedReseal = certifiedReseal.data.entityTxs.find(tx =>
      tx.type === 'accountInput' && tx.data.kind === 'board_reseal');
    if (!nestedReseal || nestedReseal.type !== 'accountInput' || nestedReseal.data.kind !== 'board_reseal') {
      throw new Error('TEST_BOARD_ROTATION_RESEAL_INPUT_MISSING');
    }
    expect(nestedReseal.data.reseal).toEqual(expect.objectContaining({
      boardActivationJHeight: 3,
      boardActivationLogIndex: 0,
      height: 7,
      frameHash: certifiedFrameHash,
      frameHanko: expect.any(String),
      disputeSeal: expect.objectContaining({
        hash: certifiedDisputeHash,
        proofBodyHash: certifiedProofBodyHash,
        proofNonce: certifiedProofNonce,
        hanko: expect.any(String),
      }),
    }));
    expect(resealedAccount.currentFrameHanko).toBe(nestedReseal.data.reseal.frameHanko);
    expect(resealedAccount.currentDisputeProofHanko).toBe(
      nestedReseal.data.reseal.disputeSeal!.hanko,
    );
    expect(getReliableOutputIdentity(certifiedResealOutput as RoutedEntityInput)).toEqual(
      expect.objectContaining({
        kind: 'account-board-reseal',
        height: 3,
        logIndex: 0,
        frameHash: certifiedFrameHash,
      }),
    );
    env.eReplicas.set(`${registeredEntityId}:${signerA}`, resealCommitted.workingReplica);
    expect((await verifyHankoForHash(
      nestedReseal.data.reseal.frameHanko!,
      certifiedFrameHash,
      registeredEntityId,
      env,
      { registeredBoardHash: newBoard, allowPreviousBoard: false },
    )).valid).toBe(true);
    expect((await verifyHankoForHash(
      nestedReseal.data.reseal.disputeSeal!.hanko!,
      certifiedDisputeHash,
      registeredEntityId,
      env,
      { registeredBoardHash: newBoard, allowPreviousBoard: false },
    )).valid).toBe(true);
  });

  test('matches independently pinned Patricia stack/key/leaf/root vectors', () => {
    const stackKey = getCertifiedBoardStackKey({
      chainId: 31_337,
      depositoryAddress: `0x${'11'.repeat(20)}`,
      entityProviderAddress: `0x${'22'.repeat(20)}`,
    });
    expect(EMPTY_CERTIFIED_BOARD_ROOT).toBe('0x8e5d9c40132e5ace5d28b5be7e67e734eb0169df12afe81e07f435723290baac');
    expect(stackKey).toBe('0xe9c8bfd53102077073e6891bbe77451100cda4b0a19f1336eb96aeff3e1e2251');
    const store = new Map();
    let root = EMPTY_CERTIFIED_BOARD_ROOT;
    const expected = [
      {
        key: '0x101d8743884cf0bcfb79aac20c3e58f2e38223ef22c443f130f465fcab2dfe5d',
        record: '0xc5416a4ffa71ec25d3597b642c76c311cd6c756eeaee5d187eac436a440550da',
        leaf: '0x885ec2edad3f6e4b40f49493a36a7e84260a9d58b6a0b2aa746062b6604e52db',
        root: '0x885ec2edad3f6e4b40f49493a36a7e84260a9d58b6a0b2aa746062b6604e52db',
      },
      {
        key: '0x6a4415fffbcfa0b81563e18f4533cef61b69e68423d73670ce00274e29b8f345',
        record: '0x0034114c44f0abe2761facbc07e82c218703ea875f169457920663cce91b06d3',
        leaf: '0x7f78f6da9150ec3d7c3c0ba84c4b32f49d9611ea425a860fd0b41e7dde5ed39d',
        root: '0xb57ad53984d1ba7b64022e25f3ecc2c313f6b205a332d8db2af671db39d70ce8',
      },
      {
        key: '0x995cbe426d58a56ecfe2c946c943b3e7c0737a8b5e3482da001332fee22e361f',
        record: '0x01295101f6cacd75dca91412f921780ef0ce37db09d9c58b2c86eaaec971cfe1',
        leaf: '0xd8c27dcb6a099fcaf5ded421300df4ca3175551c1ceeff74e0926ac2fbe94b41',
        root: '0xe50e4003b6da970ba02da7bc333368000fd9c947fe238f74f12486307cdfbbde',
      },
    ];
    for (let index = 0; index < expected.length; index += 1) {
      const number = index + 1;
      const record = {
        stackKey,
        entityId: `0x${number.toString(16).padStart(64, '0')}`,
        boardHash: `0x${(30 + number).toString(16).repeat(32)}`,
        boardEpoch: 0,
        previousBoardHash: blockHash('00'),
        previousBoardValidUntil: 0,
        activatedAtJHeight: 10 + number,
        logIndex: number,
        blockHash: `0x${(40 + number).toString(16).repeat(32)}`,
        transactionHash: `0x${(50 + number).toString(16).repeat(32)}`,
        source: 'EntityRegistered' as const,
      };
      const update = putCertifiedBoardRecord(store, root, record);
      for (const [hash, node] of update.newNodes) store.set(hash, node);
      root = update.root;
      expect(getCertifiedBoardEntityKey(stackKey, record.entityId)).toBe(expected[index]!.key);
      expect(hashCertifiedBoardRecord(record)).toBe(expected[index]!.record);
      expect([...update.newNodes].find(([, node]) => node.type === 'leaf')?.[0]).toBe(expected[index]!.leaf);
      expect(root).toBe(expected[index]!.root);
    }
  });

  test('remote observer verifies without a local replica of the numbered Entity', async () => {
    const { profile, localEnv, boardHash } = await buildRegisteredProfile();
    expect((await verifyProfileSignature(profile, localEnv)).valid).toBe(true);
    expect((await verifyProfileSignature(profile, remoteObserverEnv(boardHash))).valid).toBe(true);
  });

  for (const corruption of ['missing', 'corrupt', 'cycle'] as const) {
    test(`profile verification propagates certified-board ${corruption} corruption`, async () => {
      const { profile, localEnv } = await buildRegisteredProfile();
      const state = [...localEnv.eReplicas.values()][0]!.state;
      if (corruption === 'cycle') {
        installEvents(localEnv, state, [event('EntityRegistered', blockHash('42'), {
          entityId: generateNumberedEntityId(3),
          height: 3,
        })]);
      }
      const root = state.certifiedBoardState!.boardRegistryRoot;
      const store = getCertifiedBoardNodeStore(localEnv);
      const rootNode = store.get(root);
      if (!rootNode) throw new Error('TEST_CERTIFIED_BOARD_ROOT_NODE_MISSING');
      if (corruption === 'missing') {
        store.delete(root);
      } else if (corruption === 'corrupt') {
        store.set(root, rootNode.type === 'branch'
          ? { ...rootNode, left: rootNode.right, right: rootNode.left }
          : {
              ...rootNode,
              record: { ...rootNode.record, transactionHash: blockHash('99') },
            });
      } else {
        if (rootNode.type !== 'branch') throw new Error('TEST_CERTIFIED_BOARD_BRANCH_REQUIRED');
        store.set(root, Object.freeze({ ...rootNode, left: root, right: root }));
      }

      await expect(verifyProfileSignature(profile, localEnv)).rejects.toThrow(
        corruption === 'missing'
          ? 'CERTIFIED_BOARD_NODE_MISSING'
          : corruption === 'corrupt'
            ? 'CERTIFIED_BOARD_NODE_CORRUPT'
            : 'CERTIFIED_BOARD_NODE_CYCLE',
      );
    });
  }

  test('canonical registration, proof, clone, and missing-node corruption are fail-closed', () => {
    const env = createEmptyEnv('registry-proof');
    const state = makeState(entity('77'), addr('77'), jurisdiction);
    const foundation = event('FoundationBootstrapped', blockHash('31'));
    const registration = event('EntityRegistered', blockHash('32'));
    expect(() => applyCertifiedBoardRegistryEvent(undefined, getCertifiedBoardNodeStore(env), jurisdiction, registration))
      .toThrow('CERTIFIED_BOARD_STACK_NOT_BOOTSTRAPPED');
    installEvents(env, state, [foundation, registration]);
    expect(() => cloneEntityState(state)).not.toThrow();
    expect(resolveObserverCertifiedBoardHash(state, getCertifiedBoardNodeStore(env), registeredEntityId))
      .toBe(blockHash('32'));
    const proof = createCertifiedBoardProof(getCertifiedBoardNodeStore(env), state.certifiedBoardState!, registeredEntityId);
    expect(verifyCertifiedBoardProof(state.certifiedBoardState!.boardRegistryRoot, proof)?.boardHash).toBe(blockHash('32'));
    getCertifiedBoardNodeStore(env).delete(state.certifiedBoardState!.boardRegistryRoot);
    expect(() => resolveObserverCertifiedBoardHash(state, getCertifiedBoardNodeStore(env), registeredEntityId))
      .toThrow('CERTIFIED_BOARD_NODE_MISSING');
  });

  test('orders multiple rotations in one block by logIndex and invalidates the old proof', () => {
    const env = createEmptyEnv('registry-rotation');
    const state = makeState(entity('77'), addr('77'), jurisdiction);
    installEvents(env, state, [
      event('FoundationBootstrapped', blockHash('31')),
      event('EntityRegistered', blockHash('32'), { height: 2, logIndex: 0 }),
    ]);
    const oldRoot = state.certifiedBoardState!.boardRegistryRoot;
    const oldProof = createCertifiedBoardProof(getCertifiedBoardNodeStore(env), state.certifiedBoardState!, registeredEntityId);
    installEvents(env, state, [
      event('BoardActivated', blockHash('33'), { height: 3, logIndex: 4 }),
      event('BoardActivated', blockHash('34'), {
        height: 3,
        logIndex: 9,
        previousBoardHash: blockHash('33'),
        previousBoardValidUntil: 1_700_604_801,
      }),
    ]);
    expect(resolveObserverCertifiedBoardHash(state, getCertifiedBoardNodeStore(env), registeredEntityId)).toBe(blockHash('34'));
    expect(verifyCertifiedBoardProof(oldRoot, oldProof)?.boardHash).toBe(blockHash('32'));
    expect(() => verifyCertifiedBoardProof(state.certifiedBoardState!.boardRegistryRoot, oldProof))
      .toThrow('CERTIFIED_BOARD_PROOF_LINK_INVALID');
    expect(() => installEvents(env, state, [
      event('BoardActivated', blockHash('35'), { height: 3, logIndex: 8 }),
    ])).toThrow('CERTIFIED_BOARD_ACTIVATION_STALE');
  });

  test('reapplying an exact activation is a no-op while a same-position conflict is rejected', () => {
    const env = createEmptyEnv('registry-activation-idempotency');
    const state = makeState(entity('77'), addr('77'), jurisdiction);
    const rotation = event('BoardActivated', blockHash('33'), {
      height: 3,
      logIndex: 4,
      previousBoardHash: blockHash('32'),
    });
    installEvents(env, state, [
      event('FoundationBootstrapped', blockHash('31')),
      event('EntityRegistered', blockHash('32')),
      rotation,
    ]);
    const root = state.certifiedBoardState!.boardRegistryRoot;

    expect(() => installEvents(env, state, [rotation])).not.toThrow();
    expect(state.certifiedBoardState!.boardRegistryRoot).toBe(root);

    const conflicting = structuredClone(rotation);
    if (conflicting.type !== 'BoardActivated') throw new Error('TEST_BOARD_ACTIVATION_REQUIRED');
    conflicting.data.newBoardHash = blockHash('34');
    expect(() => installEvents(env, state, [conflicting]))
      .toThrow('CERTIFIED_BOARD_ACTIVE_CONFLICT');
    expect(state.certifiedBoardState!.boardRegistryRoot).toBe(root);
  });

  test('unique authority resolves the full latest activation position and rejects epoch conflicts', () => {
    const env = createEmptyEnv('registry-unique-full-position');
    const prefix = [
      event('FoundationBootstrapped', blockHash('31')),
      event('EntityRegistered', blockHash('32'), { height: 3, logIndex: 1 }),
    ];
    const rotations = [
      event('BoardActivated', blockHash('33'), {
        height: 3,
        logIndex: 4,
        previousBoardHash: blockHash('32'),
      }),
      event('BoardActivated', blockHash('32'), {
        height: 3,
        logIndex: 9,
        previousBoardHash: blockHash('33'),
      }),
    ];
    const stale = makeState(entity('70'), addr('70'), jurisdiction);
    const latest = makeState(entity('71'), addr('71'), jurisdiction);
    installEvents(env, stale, prefix);
    installEvents(env, latest, [...prefix, ...rotations]);
    env.eReplicas.set('stale', {
      entityId: stale.entityId,
      signerId: addr('70'),
      state: stale,
      mempool: [],
    } as EntityReplica);
    env.eReplicas.set('latest', {
      entityId: latest.entityId,
      signerId: addr('71'),
      state: latest,
      mempool: [],
    } as EntityReplica);

    expect(resolveUniqueCertifiedRegisteredBoardRecord(env, registeredEntityId)).toMatchObject({
      boardHash: blockHash('32'),
      boardEpoch: 2,
      activatedAtJHeight: 3,
      logIndex: 9,
    });

    const currentRecord = resolveObserverCertifiedBoardRecord(
      latest,
      getCertifiedBoardNodeStore(env),
      registeredEntityId,
    );
    if (!currentRecord) throw new Error('TEST_LATEST_CERTIFIED_BOARD_RECORD_MISSING');
    const conflictUpdate = putCertifiedBoardRecord(
      getCertifiedBoardNodeStore(env),
      latest.certifiedBoardState!.boardRegistryRoot,
      { ...currentRecord, boardEpoch: currentRecord.boardEpoch + 1 },
    );
    cacheCertifiedBoardNodes(env, conflictUpdate.newNodes);
    const conflict = cloneEntityState(latest);
    conflict.certifiedBoardState = {
      ...conflict.certifiedBoardState!,
      boardRegistryRoot: conflictUpdate.root,
    };
    env.eReplicas.set('conflict', {
      entityId: conflict.entityId,
      signerId: addr('72'),
      state: conflict,
      mempool: [],
    } as EntityReplica);
    expect(() => resolveUniqueCertifiedRegisteredBoardRecord(env, registeredEntityId))
      .toThrow('CERTIFIED_BOARD_AUTHORITY_AMBIGUOUS');
  });

  test('root is insertion-order independent and malformed proofs fail loudly', () => {
    const stackKey = getCertifiedBoardStackKey(jurisdiction);
    const records = [2n, 999_999n, 1_000_000n, (1n << 256n) - 1n].map((id, index) => ({
      stackKey,
      entityId: `0x${id.toString(16).padStart(64, '0')}`,
      boardHash: blockHash((60 + index).toString(16)),
      boardEpoch: 0,
      previousBoardHash: blockHash('00'),
      previousBoardValidUntil: 0,
      activatedAtJHeight: 4 + index,
      logIndex: index,
      blockHash: blockHash((70 + index).toString(16)),
      transactionHash: blockHash((80 + index).toString(16)),
      source: 'EntityRegistered' as const,
    }));
    const build = (ordered: typeof records) => {
      const store = new Map();
      let root = EMPTY_CERTIFIED_BOARD_ROOT;
      for (const record of ordered) {
        const update = putCertifiedBoardRecord(store, root, record);
        for (const [hash, node] of update.newNodes) store.set(hash, node);
        root = update.root;
      }
      return { root, store };
    };
    const forward = build(records);
    const reverse = build([...records].reverse());
    expect(reverse.root).toBe(forward.root);
    const state = {
      stackKey,
      boardRegistryRoot: forward.root,
      finalizedJHeight: 9,
      finalizedJBlockHash: blockHash('90'),
      eventHistoryRoot: blockHash('91'),
    };
    const proof = createCertifiedBoardProof(forward.store, state, records[0]!.entityId);
    expect(() => verifyCertifiedBoardProof(forward.root, { ...proof, nodes: [...proof.nodes, proof.nodes.at(-1)!] }))
      .toThrow('CERTIFIED_BOARD_PROOF_TRAILING_NODES');
    expect(() => verifyCertifiedBoardProof(forward.root, { ...proof, nodes: Array(258).fill(proof.nodes[0]!) }))
      .toThrow('CERTIFIED_BOARD_PROOF_LENGTH_INVALID');
    const terminal = proof.nodes.at(-1)!;
    if (terminal.type !== 'leaf') throw new Error('test proof terminal missing');
    expect(() => hashCertifiedBoardNode({ ...terminal, key: blockHash('ff') }))
      .toThrow('CERTIFIED_BOARD_NODE_KEY_MISMATCH');
  });

  test('supports unbounded uint256 Entity numbers and rejects zero', () => {
    const ids = [999_999n, 1_000_000n, (1n << 256n) - 1n];
    for (const [index, id] of ids.entries()) {
      const env = createEmptyEnv(`registry-id-${index}`);
      const state = makeState(entity('77'), addr('77'), jurisdiction);
      installEvents(env, state, [
        event('FoundationBootstrapped', blockHash('31')),
        event('EntityRegistered', blockHash('32'), { entityId: `0x${id.toString(16).padStart(64, '0')}` }),
      ]);
      expect(lookupCertifiedBoardRecord(
        getCertifiedBoardNodeStore(env),
        state.certifiedBoardState!.boardRegistryRoot,
        getCertifiedBoardStackKey(jurisdiction),
        `0x${id.toString(16).padStart(64, '0')}`,
      )?.boardHash).toBe(blockHash('32'));
    }
    const env = createEmptyEnv('registry-zero');
    const state = makeState(entity('77'), addr('77'), jurisdiction);
    installEvents(env, state, [event('FoundationBootstrapped', blockHash('31'))]);
    expect(() => installEvents(env, state, [
      event('EntityRegistered', blockHash('32'), { entityId: `0x${'00'.repeat(32)}` }),
    ])).toThrow('CERTIFIED_BOARD_ENTITY_NUMBER_MISMATCH');
  });

  test('local config without certified membership cannot authorize a numbered Hanko', async () => {
    const { profile, localEnv } = await buildRegisteredProfile();
    const localState = [...localEnv.eReplicas.values()][0]!.state;
    delete localState.certifiedBoardState;
    expect((await verifyProfileSignature(profile, localEnv)).valid).toBe(false);
    expect((await verifyHankoForHash(
      profile.metadata.profileHanko!, computeProfileHash(profile), registeredEntityId, localEnv,
    )).valid).toBe(false);
  });

  test('previous board verifies through nested claims at the exclusive seven-day boundary and survives restore', async () => {
    const { profile, localEnv, boardHash: previousBoardHash, privateKey } = await buildRegisteredProfile();
    const state = [...localEnv.eReplicas.values()][0]!.state;
    const currentBoardHash = blockHash('66');
    const previousBoardValidUntil = 1_700_604_800;
    installEvents(localEnv, state, [event('BoardActivated', currentBoardHash, {
      height: 3,
      previousBoardHash,
      previousBoardValidUntil,
    })]);
    const hanko = profile.metadata.profileHanko!;
    const profileHash = computeProfileHash(profile);
    const delays = resolveHankoBoardDelays();
    const anchor = zeroPadValue('0x1234567890123456789012345678901234567890', 32).toLowerCase() as `0x${string}`;
    const parentEntityId = hashHankoBoardClaim({
      entityId: `0x${'00'.repeat(32)}`,
      members: [
        { entityId: anchor, weight: 1n },
        { entityId: registeredEntityId as `0x${string}`, weight: 1n },
      ],
      threshold: 1n,
      delays,
    });
    const nestedHanko = encodeSignedHanko({
      digest: profileHash,
      privateKeys: [privateKey],
      placeholders: [anchor],
      claims: [
        {
          entityId: registeredEntityId as `0x${string}`,
          entityIndexes: [1n],
          weights: [1n],
          threshold: 1n,
          ...delays,
        },
        {
          entityId: parentEntityId,
          entityIndexes: [0n, 2n],
          weights: [1n, 1n],
          threshold: 1n,
          ...delays,
        },
      ],
    });

    localEnv.timestamp = previousBoardValidUntil * 1_000 - 1;
    expect((await verifyHankoForHash(
      hanko,
      profileHash,
      registeredEntityId,
      localEnv,
      { registeredBoardHash: currentBoardHash },
    )).valid).toBe(true);
    expect((await verifyHankoForHash(
      hanko,
      profileHash,
      registeredEntityId,
      localEnv,
      { registeredBoardHash: currentBoardHash, allowPreviousBoard: false },
    )).valid).toBe(false);
    expect((await verifyHankoForHash(
      nestedHanko,
      profileHash,
      parentEntityId,
      localEnv,
    )).valid).toBe(true);
    expect((await verifyHankoForHash(
      nestedHanko,
      profileHash,
      parentEntityId,
      localEnv,
      { allowPreviousBoard: false },
    )).valid).toBe(false);

    const restored = await restoreEnvFromCheckpointSnapshot(buildRuntimeCheckpointSnapshot(localEnv), {
      runtimeId: addr('88'),
    });
    restored.timestamp = localEnv.timestamp;
    expect((await verifyHankoForHash(
      hanko,
      profileHash,
      registeredEntityId,
      restored,
      { registeredBoardHash: currentBoardHash },
    )).valid).toBe(true);
    expect((await verifyHankoForHash(
      nestedHanko,
      profileHash,
      parentEntityId,
      restored,
    )).valid).toBe(true);

    restored.timestamp = previousBoardValidUntil * 1_000;
    expect((await verifyHankoForHash(
      hanko,
      profileHash,
      registeredEntityId,
      restored,
      { registeredBoardHash: currentBoardHash },
    )).valid).toBe(false);
    expect((await verifyHankoForHash(
      nestedHanko,
      profileHash,
      parentEntityId,
      restored,
    )).valid).toBe(false);
  });

  test('recovery checkpoint carries only reachable nodes into a fresh runtime', async () => {
    const { profile, localEnv, boardHash } = await buildRegisteredProfile();
    const snapshot = buildRuntimeCheckpointSnapshot(localEnv);
    const durableState = snapshot['runtimeState'] as { certifiedBoardNodes?: Map<string, unknown> };
    expect(durableState.certifiedBoardNodes?.size).toBeGreaterThan(0);
    // A recovery checkpoint never persists private keys. Clear the in-process
    // vault cache so this restore exercises a genuinely fresh observer runtime
    // instead of accidentally inheriting ownership from the fixture builder.
    clearSignerKeys(localEnv);
    const restored = await restoreEnvFromCheckpointSnapshot(snapshot, {
      runtimeSeed: localEnv.runtimeSeed,
      runtimeId: localEnv.runtimeId,
    });
    expect(resolveObserverCertifiedBoardHash(
      [...restored.eReplicas.values()][0]!.state,
      getCertifiedBoardNodeStore(restored),
      registeredEntityId,
    )).toBe(boardHash);
    expect((await verifyProfileSignature(profile, restored)).valid).toBe(true);
  });
});
