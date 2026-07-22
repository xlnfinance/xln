import { describe, expect, test } from 'bun:test';

import {
  deriveSignerAddressSync,
  deriveSignerKeySync,
  registerSignerKey,
  signAccountFrame,
} from '../account/crypto';
import { buildQuorumHanko } from '../hanko/signing';
import {
  applyReliableDeliveryReceipts,
  captureReliableReceiptSenderCheckpoint,
  commitReliableIngress,
  finalizeReliableIngressCommit,
  getReliableDeliveryReceiptValidationError,
  registerReliableIngress,
  registerReliableReceiptIngress,
  releaseUncommittedReliableIngress,
  rollbackReliableDeliveryReceipts,
  rollbackReliableIngressCommit,
} from '../machine/reliable-delivery';
import { canonicalJEventRangeHash, EMPTY_J_HISTORY_ROOT } from '../jurisdiction/history-consensus';
import {
  buildLocalJPrefixAttestation,
  hashJPrefixAttestation,
  mergeJPrefixAttestations,
} from '../jurisdiction/j-prefix-consensus';
import {
  hashCertifiedEntityOutput,
  hashCertifiedEntityOutputSemantic,
} from '../entity/consensus/output-certification';
import { generateLazyEntityId } from '../entity/factory';
import { applyMergedEntityInputs } from '../machine/entity-inputs';
import { recordValidatorJHistory } from '../jurisdiction/local-history';
import { buildDurableRuntimeMachineSnapshot, restoreDurableRuntimeSnapshot } from '../wal/snapshot';
import {
  buildCatchupFixtureCertificate,
  catchupFixtureDeliverable,
  createCatchupFixtureState,
  prepareCatchupFixtureReplica,
  registerCatchupFixtureSigners,
} from './fixtures/reliable-local-catchup-fixture';
import {
  createEmptyEnv,
  getFrameDb,
  handleInboundReliableReceipt,
  process as processRuntime,
} from '../runtime';
import { readStorageFrameRecord } from '../storage';
import { buildRouteOutputKey, getReliableOutputIdentity } from '../machine/output-routing';
import type {
  AccountMachine,
  DeliverableEntityInput,
  EntityTx,
  EntityReplica,
  Env,
  JPrefixAttestation,
  ReliableDeliveryReceipt,
} from '../types';
import { makeAccount } from './helpers/cross-j';

const TEST_RUN_ID = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;

const runtime = (seed: string): Env => {
  const env = createEmptyEnv(seed);
  const runtimeId = deriveSignerAddressSync(seed, '1').toLowerCase();
  registerSignerKey(env, runtimeId, deriveSignerKeySync(seed, '1'));
  env.runtimeId = runtimeId;
  env.runtimeSeed = seed;
  env.runtimeState ??= {};
  return env;
};

const entityId = (byte: string): string => `0x${byte.repeat(32)}`;
const signerId = (byte: string): string => `0x${byte.repeat(20)}`;

const frameOutput = (
  receiverRuntimeId: string,
  height = 7,
  frameHash = `0x${'ab'.repeat(32)}`,
  hankos?: string[],
): DeliverableEntityInput => ({
  runtimeId: receiverRuntimeId,
  entityId: entityId('b1'),
  signerId: signerId('b2'),
  proposedFrame: {
    height,
    parentFrameHash: height === 1 ? 'genesis' : `0x${'cd'.repeat(32)}`,
    stateRoot: `0x${'ce'.repeat(32)}`,
    authorityRoot: `0x${'cf'.repeat(32)}`,
    timestamp: height,
    hash: frameHash,
    txs: [],
    leader: { proposerSignerId: signerId('b2'), view: 0 },
    collectedSigs: new Map(),
    ...(hankos ? { hankos } : {}),
  } as never,
});

const precommitOutput = (
  receiverRuntimeId: string,
  bundles: Array<[string, string[]]>,
  height = 7,
  frameHash = `0x${'ab'.repeat(32)}`,
): DeliverableEntityInput => ({
  runtimeId: receiverRuntimeId,
  entityId: entityId('b1'),
  signerId: signerId('b2'),
  hashPrecommitFrame: { height, frameHash },
  hashPrecommits: new Map(bundles),
} as never);

const accountAckOutput = (
  receiverRuntimeId: string,
  height = 7,
  frameHash = `0xaccount-frame-${height}`,
): DeliverableEntityInput => ({
  runtimeId: receiverRuntimeId,
  entityId: entityId('b1'),
  signerId: signerId('b2'),
  entityTxs: [{
    type: 'accountInput',
    data: {
      kind: 'ack',
      fromEntityId: entityId('d1'),
      toEntityId: entityId('b1'),
      ack: { height, frameHash, frameHanko: `0xhanko-${height}` },
    },
  } as never],
});

const certifiedAccountAckOutput = (
  receiverRuntimeId: string,
  height = 7,
  originOverrides: Partial<Extract<EntityTx, { type: 'consensusOutput' }>['data']['origin']> = {},
  outputHanko = `0x${'ab'.repeat(65)}`,
): DeliverableEntityInput => {
  const sourceEntityId = entityId('d1');
  const targetEntityId = entityId('b1');
  const entityTxs = structuredClone(accountAckOutput(receiverRuntimeId, height).entityTxs!);
  const lane = originOverrides.lane ?? 'account-ack';
  const sequence = originOverrides.sequence ?? BigInt(height);
  const semanticHash = originOverrides.semanticHash ?? hashCertifiedEntityOutputSemantic(
    sourceEntityId,
    targetEntityId,
    lane,
    sequence,
    entityTxs,
  );
  return {
    runtimeId: receiverRuntimeId,
    entityId: targetEntityId,
    signerId: signerId('b2'),
    entityTxs: [{
      type: 'consensusOutput',
      data: {
        origin: {
          sourceEntityId,
          lane,
          sequence,
          semanticHash,
          height: 19,
          frameHash: entityId('e1'),
          outputIndex: 3,
          ...originOverrides,
        },
        outputHanko,
        targetEntityId,
        entityTxs,
      },
    }],
  };
};

const accountFrameAckOutput = (
  receiverRuntimeId: string,
  height = 7,
  proposalStateHash = `0xproposal-state-${height + 1}`,
): DeliverableEntityInput => ({
  ...accountAckOutput(receiverRuntimeId, height),
  entityTxs: [{
    type: 'accountInput',
    data: {
      kind: 'frame_ack',
      fromEntityId: entityId('d1'),
      toEntityId: entityId('b1'),
      ack: {
        height,
        frameHash: `0xaccount-frame-${height}`,
        frameHanko: `0xack-hanko-${height}`,
      },
      proposal: {
        frame: {
          height: height + 1,
          timestamp: height + 1,
          jHeight: height + 1,
          accountTxs: [],
          prevFrameHash: `0xaccount-frame-${height}`,
          accountStateRoot: `0xaccount-root-${height + 1}`,
          stateHash: proposalStateHash,
          deltas: [],
        },
        frameHanko: `0xproposal-hanko-${height + 1}`,
      },
    },
  } as never],
});

const jFinalityOutput = (
  receiverRuntimeId: string,
  scannedThroughHeight: number,
  eventHistoryRoot = `0x${scannedThroughHeight.toString(16).padStart(64, '1')}`,
): DeliverableEntityInput => ({
  runtimeId: receiverRuntimeId,
  entityId: entityId('b1'),
  signerId: signerId('b2'),
  entityTxs: [{
    type: 'j_event',
    data: {
      from: signerId('c3'),
      jurisdictionRef: 'stack:31337:0x00000000000000000000000000000000000000aa',
      baseHeight: Math.max(0, scannedThroughHeight - 10),
      scannedThroughHeight,
      observedAt: scannedThroughHeight,
      blocks: [],
      tipBlockHash: `0x${scannedThroughHeight.toString(16).padStart(64, '0')}`,
      rangeHash: `0x${'31'.repeat(32)}`,
      eventHistoryRoot,
      signature: `0xj-signature-${scannedThroughHeight}`,
    },
  } as never],
});

const jPrefixAttestationOutput = (
  receiverRuntimeId: string,
  scannedThroughHeight: number,
  signatureByte: string,
): DeliverableEntityInput => {
  const sourceValidatorId = signerId('c3');
  const attestation: JPrefixAttestation = {
    version: 1,
    entityId: entityId('b1'),
    targetEntityHeight: 1,
    parentFrameHash: 'genesis',
    validatorId: sourceValidatorId,
    jurisdictionRef: 'stack:31337:0x00000000000000000000000000000000000000aa',
    baseHeight: 10,
    scannedThroughHeight,
    tipBlockHash: `0x${scannedThroughHeight.toString(16).padStart(64, '0')}`,
    eventHistoryRoot: `0x${'41'.repeat(32)}`,
    rangeHash: `0x${'42'.repeat(32)}`,
    headers: Array.from({ length: scannedThroughHeight - 10 }, (_, index) => ({
      jHeight: 11 + index,
      jBlockHash: `0x${(11 + index).toString(16).padStart(64, '0')}`,
    })),
    blocks: [],
    signature: `0x${signatureByte.repeat(65)}`,
  };
  return {
    runtimeId: receiverRuntimeId,
    entityId: entityId('b1'),
    signerId: signerId('b2'),
    jPrefixAttestations: new Map([[sourceValidatorId, attestation]]),
  };
};

const signedStaleJPrefixOutput = (
  receiver: Env,
  source: Env,
): DeliverableEntityInput => {
  const sourceValidatorId = deriveSignerAddressSync(source.runtimeSeed!, 'stale-j-prefix-source').toLowerCase();
  registerSignerKey(
    source,
    sourceValidatorId,
    deriveSignerKeySync(source.runtimeSeed!, 'stale-j-prefix-source'),
  );
  const jurisdictionRef = 'stack:31337:0x00000000000000000000000000000000000000aa';
  const unsigned: Omit<JPrefixAttestation, 'signature'> = {
    version: 1,
    entityId: entityId('b1'),
    targetEntityHeight: 1,
    parentFrameHash: 'genesis',
    validatorId: sourceValidatorId,
    jurisdictionRef,
    baseHeight: 10,
    scannedThroughHeight: 10,
    tipBlockHash: `0x${'10'.padStart(64, '0')}`,
    eventHistoryRoot: EMPTY_J_HISTORY_ROOT,
    rangeHash: canonicalJEventRangeHash(jurisdictionRef, []),
    headers: [],
    blocks: [],
  };
  return {
    runtimeId: receiver.runtimeId!,
    entityId: entityId('b1'),
    signerId: signerId('b2'),
    jPrefixAttestations: new Map([[
      sourceValidatorId,
      {
        ...unsigned,
        signature: signAccountFrame(source, sourceValidatorId, hashJPrefixAttestation(unsigned)),
      },
    ]]),
  };
};

const installStaleJPrefixAuthority = (
  receiver: Env,
  output: DeliverableEntityInput,
): void => {
  const attestation = output.jPrefixAttestations?.values().next().value;
  if (!attestation) throw new Error('TEST_SIGNED_STALE_J_PREFIX_MISSING');
  receiver.eReplicas.set(`${output.entityId}:${output.signerId}`, {
    entityId: output.entityId,
    signerId: output.signerId,
    isProposer: false,
    mempool: [],
    state: {
      entityId: output.entityId,
      height: 1,
      prevFrameHash: `0x${'a7'.repeat(32)}`,
      lastFinalizedJHeight: 10,
      jBlockChain: [],
      accounts: new Map(),
      config: {
        mode: 'proposer-based',
        threshold: 1n,
        validators: [attestation.validatorId],
        shares: { [attestation.validatorId]: 1n },
        jurisdiction: {
          name: 'ReliableStaleJPrefix',
          address: 'http://127.0.0.1:8545',
          chainId: 31337,
          depositoryAddress: '0x00000000000000000000000000000000000000aa',
        },
      },
    },
  } as unknown as EntityReplica);
};

const ensureAppliedAuthority = (env: Env, output: DeliverableEntityInput): void => {
  const key = `${output.entityId}:${output.signerId}`;
  const replica = env.eReplicas.get(key) ?? ({
    entityId: output.entityId,
    signerId: output.signerId,
    isProposer: false,
    mempool: [],
    state: {
      entityId: output.entityId,
      height: 0,
      prevFrameHash: '',
      lastFinalizedJHeight: 0,
      jBlockChain: [],
      accounts: new Map(),
    },
  } as unknown as EntityReplica);
  if (output.proposedFrame) {
    if (output.proposedFrame.hankos?.length) {
      replica.state.height = output.proposedFrame.height;
      replica.state.prevFrameHash = output.proposedFrame.hash;
      delete replica.lockedFrame;
    } else {
      replica.lockedFrame = structuredClone(output.proposedFrame);
    }
  }
  if (output.hashPrecommitFrame && output.hashPrecommits) {
    replica.lockedFrame = {
      height: output.hashPrecommitFrame.height,
      timestamp: output.hashPrecommitFrame.height,
      hash: output.hashPrecommitFrame.frameHash,
      txs: [],
      leader: { proposerSignerId: output.signerId, view: 0 },
      collectedSigs: structuredClone(output.hashPrecommits),
    };
  }
  replica.mempool.push(...structuredClone(output.entityTxs ?? []));
  env.eReplicas.set(key, replica);
};

const commitApplied = (receiver: Env, outputs: DeliverableEntityInput[]) => {
  for (const output of outputs) ensureAppliedAuthority(receiver, output);
  return commitReliableIngress(receiver, outputs);
};

const receiverFrontierCount = (env: Env): number =>
  (env.runtimeState?.reliableIngressReceiptLedger?.size ?? 0) +
  (env.runtimeState?.reliableIngressTerminalWatermarks?.size ?? 0);

const senderFrontierCount = (env: Env): number =>
  (env.runtimeState?.receivedReliableReceiptLedger?.size ?? 0) +
  (env.runtimeState?.receivedReliableTerminalWatermarks?.size ?? 0);

const commitAtReceiver = (
  receiver: Env,
  senderRuntimeId: string,
  output: DeliverableEntityInput,
) => {
  expect(registerReliableIngress(receiver, senderRuntimeId, output).kind).toBe('enqueue');
  const commits = commitApplied(receiver, [output]);
  expect(commits).toHaveLength(1);
  return commits;
};

const commitTerminalAccountAtReceiver = (
  receiver: Env,
  senderRuntimeId: string,
  output: DeliverableEntityInput,
  height: number,
  frameHash: string,
) => {
  expect(registerReliableIngress(receiver, senderRuntimeId, output).kind).toBe('enqueue');
  ensureAppliedAuthority(receiver, output);
  const replica = receiver.eReplicas.get(`${output.entityId}:${output.signerId}`);
  if (!replica) throw new Error('TEST_ACCOUNT_RECEIPT_REPLICA_MISSING');
  replica.state.accounts.set(entityId('d1'), {
    leftEntity: entityId('d1'),
    rightEntity: output.entityId,
    currentHeight: height,
    currentFrame: { stateHash: frameHash },
  } as never);
  const commits = commitReliableIngress(receiver, [output]);
  expect(commits).toHaveLength(1);
  finalizeReliableIngressCommit(receiver, commits);
  return commits;
};

describe('durable scoped reliable delivery receipts', () => {
  test('certified Account ACK keeps exact receipt identity across restart and semantic reissue GC', () => {
    const sender = runtime('reliable-receipt-certified-account-sender');
    const receiver = runtime('reliable-receipt-certified-account-receiver');
    const output = certifiedAccountAckOutput(receiver.runtimeId!);
    const commits = commitAtReceiver(receiver, sender.runtimeId!, output);
    const receipt = commits[0]!.receipt;
    if (!receipt) throw new Error('TEST_CERTIFIED_ACCOUNT_RECEIPT_MISSING');

    expect(receipt.body.identity).toMatchObject({
      kind: 'account-ack',
      entityId: entityId('b1'),
      height: 7,
      frameHash: '0xaccount-frame-7',
      evidenceKind: 'account-ack',
    });
    finalizeReliableIngressCommit(receiver, commits);

    const snapshot = buildDurableRuntimeMachineSnapshot(receiver);
    const restored = runtime('reliable-receipt-certified-account-receiver');
    restoreDurableRuntimeSnapshot(restored, snapshot);
    const duplicate = registerReliableIngress(restored, sender.runtimeId!, output);
    expect(duplicate.kind).toBe('receipt');
    if (duplicate.kind !== 'receipt') throw new Error('TEST_CERTIFIED_ACCOUNT_DUPLICATE_RECEIPT_MISSING');
    expect(duplicate.receipt).toEqual(receipt);

    const semanticReissue = certifiedAccountAckOutput(
      receiver.runtimeId!,
      7,
      { height: 20, frameHash: entityId('e2'), outputIndex: 4 },
      `0x${'cd'.repeat(65)}`,
    );
    const nextAck = certifiedAccountAckOutput(receiver.runtimeId!, 8);
    sender.pendingNetworkOutputs = [semanticReissue, nextAck];

    expect(applyReliableDeliveryReceipts(sender, [duplicate.receipt])).toEqual({ removed: 1 });
    expect(sender.pendingNetworkOutputs).toEqual([nextAck]);
  });

  test('receiver ACKs only after the receipt ledger crosses a durable restart boundary', () => {
    const sender = runtime('reliable-receipt-sender-a');
    const receiver = runtime('reliable-receipt-receiver-a');
    const output = frameOutput(receiver.runtimeId!);
    const commits = commitAtReceiver(receiver, sender.runtimeId!, output);

    expect(registerReliableIngress(receiver, sender.runtimeId!, output).kind).toBe('pending');

    const snapshot = buildDurableRuntimeMachineSnapshot(receiver);
    const restored = runtime('reliable-receipt-receiver-a');
    restoreDurableRuntimeSnapshot(restored, snapshot);
    const duplicate = registerReliableIngress(restored, sender.runtimeId!, output);

    expect(duplicate.kind).toBe('receipt');
    expect(duplicate.receipt).toEqual(commits[0]?.receipt);
    expect(getReliableDeliveryReceiptValidationError(restored, duplicate.receipt!)).toBeNull();
  });

  test('dropped receipt is regenerated from the durable ledger without reapplying input', () => {
    const sender = runtime('reliable-receipt-sender-b');
    const receiver = runtime('reliable-receipt-receiver-b');
    const output = frameOutput(receiver.runtimeId!);
    const commits = commitAtReceiver(receiver, sender.runtimeId!, output);
    finalizeReliableIngressCommit(receiver, commits);

    const duplicate = registerReliableIngress(receiver, sender.runtimeId!, output);
    expect(duplicate.kind).toBe('receipt');
    expect(duplicate.receipt).toEqual(commits[0]?.receipt);
  });

  test('an atomic cross-j envelope admits the contiguous Account ACK behind its queued predecessor', () => {
    const sender = runtime('reliable-cross-j-contiguous-sender');
    const receiver = runtime('reliable-cross-j-contiguous-receiver');
    const predecessor = certifiedAccountAckOutput(receiver.runtimeId!, 2);
    const bundledSuccessor = certifiedAccountAckOutput(receiver.runtimeId!, 3);

    expect(registerReliableIngress(receiver, sender.runtimeId!, predecessor).kind).toBe('enqueue');
    expect(registerReliableIngress(receiver, sender.runtimeId!, bundledSuccessor).kind).toBe('pending');
    expect(registerReliableIngress(receiver, sender.runtimeId!, bundledSuccessor, {
      allowContiguousPendingAccountAck: true,
    }).kind).toBe('enqueue');
    expect(receiver.runtimeState?.pendingReliableIngress?.size).toBe(2);
    expect(registerReliableIngress(receiver, sender.runtimeId!, bundledSuccessor, {
      allowContiguousPendingAccountAck: true,
    }).kind).toBe('pending');
  });

  test('an Account ACK staged behind another Entity transition stays pending until its exact frame commits', () => {
    const sender = runtime('reliable-receipt-staged-account-ack-sender');
    const receiver = runtime('reliable-receipt-staged-account-ack-receiver');
    const output = accountAckOutput(receiver.runtimeId!, 10, '0xaccount-frame-10');

    expect(registerReliableIngress(receiver, sender.runtimeId!, output).kind).toBe('enqueue');
    ensureAppliedAuthority(receiver, output);
    const replica = receiver.eReplicas.get(`${output.entityId}:${output.signerId}`);
    if (!replica) throw new Error('TEST_STAGED_ACCOUNT_ACK_REPLICA_MISSING');
    replica.mempool = [];
    replica.state.accounts.set(entityId('d1'), {
      leftEntity: entityId('d1'),
      rightEntity: output.entityId,
      currentHeight: 9,
      currentFrame: { height: 9, stateHash: '0xaccount-frame-9' },
      pendingFrame: {
        height: 10,
        prevFrameHash: '0xaccount-frame-9',
        stateHash: '0xaccount-frame-10',
      },
      mempool: [],
    } as never);

    // An unrelated Entity transition may persist this exact ACK in the Entity
    // mempool without applying it to the bilateral Account yet. That is not an
    // application receipt: the source must retain the output until H10 commits.
    expect(commitReliableIngress(receiver, [output])).toEqual([]);
    expect(receiver.runtimeState?.reliableIngressReceiptLedger?.size ?? 0).toBe(0);
    releaseUncommittedReliableIngress(receiver, [output], [output]);
    expect(receiver.runtimeState?.pendingReliableIngress?.size ?? 0).toBe(0);
    expect(registerReliableIngress(receiver, sender.runtimeId!, output).kind).toBe('enqueue');

    const account = replica.state.accounts.get(entityId('d1'))!;
    account.currentHeight = 10;
    account.currentFrame = {
      height: 10,
      prevFrameHash: '0xaccount-frame-9',
      stateHash: '0xaccount-frame-10',
    } as never;
    delete account.pendingFrame;

    const commits = commitReliableIngress(receiver, [output]);
    expect(commits).toHaveLength(1);
    expect(commits[0]?.receipt?.body).toMatchObject({
      coverage: 'terminal',
      identity: { kind: 'account-ack', height: 10, frameHash: '0xaccount-frame-10' },
    });
  });

  test('authenticated empty suffix does not stage a certified ACK behind a fabricated J-prefix roll', async () => {
    const sender = runtime('reliable-certified-ack-frozen-prefix-sender');
    const receiver = runtime('reliable-certified-ack-frozen-prefix-receiver');
    receiver.scenarioMode = true;
    receiver.quietRuntimeLogs = true;
    receiver.timestamp = 2_000;

    const validatorId = receiver.runtimeId!;
    const targetEntityId = generateLazyEntityId([validatorId], 1n).toLowerCase();
    const sourceSignerId = deriveSignerAddressSync(receiver.runtimeSeed!, 'frozen-prefix-source').toLowerCase();
    registerSignerKey(
      receiver,
      sourceSignerId,
      deriveSignerKeySync(receiver.runtimeSeed!, 'frozen-prefix-source'),
    );
    const sourceEntityId = generateLazyEntityId([sourceSignerId], 1n).toLowerCase();
    const sourceConfig = {
      mode: 'proposer-based' as const,
      threshold: 1n,
      validators: [sourceSignerId],
      shares: { [sourceSignerId]: 1n },
    };
    const depositoryAddress = signerId('a1');
    const jurisdictionRef = `stack:31337:${depositoryAddress}`;
    const jBlockHash = (height: number): string => `0x${height.toString(16).padStart(64, '0')}`;
    const account = makeAccount(targetEntityId, sourceEntityId, {
      chainId: 31_337,
      depositoryAddress,
    });
    account.currentHeight = 9;
    account.currentFrame = {
      ...account.currentFrame,
      height: 9,
      timestamp: 1_000,
      jHeight: 10,
      prevFrameHash: `0x${'08'.repeat(32)}`,
      accountStateRoot: `0x${'19'.repeat(32)}`,
      stateHash: `0x${'09'.repeat(32)}`,
    };
    const pendingFrame = {
      ...account.currentFrame,
      height: 10,
      timestamp: 2_000,
      prevFrameHash: account.currentFrame.stateHash,
      accountStateRoot: `0x${'20'.repeat(32)}`,
      stateHash: `0x${'10'.repeat(32)}`,
    };
    const ackHanko = await buildQuorumHanko(receiver, sourceEntityId, pendingFrame.stateHash, [{
      signerId: sourceSignerId,
      signature: signAccountFrame(receiver, sourceSignerId, pendingFrame.stateHash),
    }], sourceConfig);
    account.pendingFrame = pendingFrame;
    account.pendingAccountInput = {
      kind: 'frame',
      fromEntityId: account.proofHeader.fromEntity,
      toEntityId: account.proofHeader.toEntity,
      domain: structuredClone(account.domain),
      proposal: {
        frame: structuredClone(pendingFrame),
        frameHanko: `0x${'33'.repeat(65)}`,
      },
    };
    account.pendingAccountInputSignerId = sender.runtimeId!;

    const state = {
      entityId: targetEntityId,
      height: 0,
      prevFrameHash: 'genesis',
      timestamp: 1_000,
      nonces: new Map(),
      messages: [],
      proposals: new Map(),
      config: {
        mode: 'proposer-based' as const,
        threshold: 1n,
        validators: [validatorId],
        shares: { [validatorId]: 1n },
        jurisdiction: {
          name: 'ReliableFrozenPrefix',
          address: 'http://127.0.0.1:8545',
          chainId: 31_337,
          depositoryAddress,
          entityProviderAddress: signerId('a2'),
          registrationBlock: 10,
        },
      },
      reserves: new Map(),
      accounts: new Map([[sourceEntityId, account]]),
      lastFinalizedJHeight: 10,
      jBlockChain: [],
      jHistoryFinality: {
        jurisdictionRef,
        baseHeight: 0,
        finalizedThroughHeight: 10,
        tipBlockHash: jBlockHash(10),
        eventHistoryRoot: EMPTY_J_HISTORY_ROOT,
        proposerSignerId: validatorId,
        proposerSignature: '0xgenesis',
        entityHeight: 0,
      },
      entityEncPubKey: 'pub',
      entityEncPrivKey: 'priv',
      profile: { name: 'Reliable frozen prefix', isHub: false, avatar: '', bio: '', website: '' },
      htlcRoutes: new Map(),
      htlcFeesEarned: 0n,
      lockBook: new Map(),
    };
    const historyAt10 = recordValidatorJHistory(undefined, {
      jurisdictionRef,
      scannedThroughHeight: 10,
      tipBlockHash: jBlockHash(10),
      headers: [{ jHeight: 10, jBlockHash: jBlockHash(10) }],
      blocks: [],
    }, state);
    const replica: EntityReplica = {
      entityId: targetEntityId,
      signerId: validatorId,
      state,
      mempool: [],
      isProposer: true,
      jHistory: historyAt10,
    };
    const frozenHead = buildLocalJPrefixAttestation(receiver, replica);
    if (!frozenHead) throw new Error('TEST_FROZEN_PREFIX_HEAD_MISSING');
    replica.jPrefixRound = mergeJPrefixAttestations(
      receiver,
      state,
      undefined,
      new Map([[validatorId, frozenHead]]),
    );
    replica.jHistory = recordValidatorJHistory(historyAt10, {
      jurisdictionRef,
      scannedThroughHeight: 110,
      tipBlockHash: jBlockHash(110),
      headers: Array.from({ length: 100 }, (_, index) => ({
        jHeight: 11 + index,
        jBlockHash: jBlockHash(11 + index),
      })),
      blocks: [],
    }, state);
    receiver.eReplicas.set(`${targetEntityId}:${validatorId}`, replica);

    const nestedAck: EntityTx = {
      type: 'accountInput',
      data: {
        kind: 'ack',
        fromEntityId: sourceEntityId,
        toEntityId: targetEntityId,
        domain: structuredClone(account.domain),
        watchSeed: account.watchSeed,
        ack: {
          height: 10,
          frameHash: pendingFrame.stateHash,
          frameHanko: ackHanko,
        },
      },
    } as never;
    const semanticHash = hashCertifiedEntityOutputSemantic(
      sourceEntityId,
      targetEntityId,
      'account-ack',
      10n,
      [nestedAck],
    );
    const origin = {
      sourceEntityId,
      lane: 'account-ack' as const,
      sequence: 10n,
      semanticHash,
      height: 19,
      frameHash: entityId('e1'),
      outputIndex: 0,
    };
    const outputHash = hashCertifiedEntityOutput(origin, targetEntityId, [nestedAck]);
    const outputHanko = await buildQuorumHanko(receiver, sourceEntityId, outputHash, [{
      signerId: sourceSignerId,
      signature: signAccountFrame(receiver, sourceSignerId, outputHash),
    }], sourceConfig);
    const output: DeliverableEntityInput = {
      runtimeId: receiver.runtimeId!,
      entityId: targetEntityId,
      signerId: validatorId,
      entityTxs: [{
        type: 'consensusOutput',
        data: {
          origin: {
            ...origin,
          },
          outputHanko,
          targetEntityId,
          entityTxs: [nestedAck],
        },
      }],
    };
    expect(registerReliableIngress(receiver, sender.runtimeId!, output).kind).toBe('enqueue');

    const applied = await applyMergedEntityInputs(receiver, [{ ...output, from: sender.runtimeId! }], [], {
      isReplay: false,
      routingDeps: {
        ensureRuntimeState: targetEnv => targetEnv.runtimeState!,
        enqueueRuntimeInputs: () => {},
        extractEntityId: replicaKey => replicaKey.split(':')[0] ?? '',
        hasLocalSignerForEntity: () => true,
        hasLocalSignerForEntitySigner: () => true,
        resolveSoleLocalSignerForEntity: () => validatorId,
        getP2P: () => null,
      },
    });

    expect(applied.entityFrameCommitted).toBe(true);
    expect(applied.appliedEntityInputs).toHaveLength(1);
    expect(receiver.eReplicas.get(`${targetEntityId}:${validatorId}`)?.state.height).toBe(1);
    const committedAccount = receiver.eReplicas
      .get(`${targetEntityId}:${validatorId}`)?.state.accounts.get(sourceEntityId) as AccountMachine | undefined;
    if (!committedAccount) throw new Error('TEST_FROZEN_PREFIX_ACCOUNT_MISSING');
    expect(committedAccount.currentHeight).toBe(10);
    expect(committedAccount.pendingFrame).toBeUndefined();

    const commits = commitReliableIngress(receiver, applied.appliedEntityInputs);
    expect(commits).toHaveLength(1);
    expect(commits[0]?.receipt?.body).toMatchObject({
      coverage: 'terminal',
      identity: { kind: 'account-ack', height: 10, frameHash: pendingFrame.stateHash },
    });
    finalizeReliableIngressCommit(receiver, commits);
    expect(receiver.runtimeState?.pendingReliableIngress?.size ?? 0).toBe(0);
  });

  test('failed receiver WAL commit exposes no application receipt', () => {
    const sender = runtime('reliable-receipt-sender-wal-fail');
    const receiver = runtime('reliable-receipt-receiver-wal-fail');
    const output = frameOutput(receiver.runtimeId!);
    const commits = commitAtReceiver(receiver, sender.runtimeId!, output);

    rollbackReliableIngressCommit(receiver, commits);

    expect(receiver.runtimeState?.reliableIngressReceiptLedger?.size).toBe(0);
    expect(registerReliableIngress(receiver, sender.runtimeId!, output).kind).toBe('pending');
  });

  test('receiver rejects conflicting frameHash at the same reliable lane height', () => {
    const sender = runtime('reliable-receipt-sender-c');
    const receiver = runtime('reliable-receipt-receiver-c');
    const output = frameOutput(receiver.runtimeId!, 7, `0x${'ca'.repeat(32)}`);
    registerReliableIngress(receiver, sender.runtimeId!, output);

    expect(() => registerReliableIngress(
      receiver,
      sender.runtimeId!,
      frameOutput(receiver.runtimeId!, 7, `0x${'cb'.repeat(32)}`),
    )).toThrow('RELIABLE_INGRESS_LANE_ORDER_CONFLICT');
  });

  test('stale J-prefix ACK requires the exact attestation retained by certified frame lineage', () => {
    const sender = runtime('reliable-receipt-j-prefix-lineage-sender');
    const receiver = runtime('reliable-receipt-j-prefix-lineage-receiver');
    const honest = jPrefixAttestationOutput(receiver.runtimeId!, 11, '51');
    const forged = jPrefixAttestationOutput(receiver.runtimeId!, 12, '52');
    ensureAppliedAuthority(receiver, honest);
    const replica = receiver.eReplicas.get(`${honest.entityId}:${honest.signerId}`);
    if (!replica) throw new Error('TEST_J_PREFIX_REPLICA_MISSING');
    replica.state.height = 1;
    const honestAttestation = honest.jPrefixAttestations!.values().next().value!;
    replica.certifiedFrameLineage = [{
      frame: {
        height: 1,
        jPrefixCertificate: {
          version: 1,
          entityId: honest.entityId,
          targetEntityHeight: 1,
          parentFrameHash: 'genesis',
          jurisdictionRef: honestAttestation.jurisdictionRef,
          baseHeight: honestAttestation.baseHeight,
          selected: {
            jurisdictionRef: honestAttestation.jurisdictionRef,
            baseHeight: honestAttestation.baseHeight,
            scannedThroughHeight: honestAttestation.scannedThroughHeight,
            tipBlockHash: honestAttestation.tipBlockHash,
            eventHistoryRoot: honestAttestation.eventHistoryRoot,
            rangeHash: honestAttestation.rangeHash,
            blocks: [],
          },
          signerIds: [honestAttestation.validatorId],
          attestations: new Map([[honestAttestation.validatorId, honestAttestation]]),
        },
      },
      postAuthority: {},
    }] as never;

    expect(registerReliableIngress(receiver, sender.runtimeId!, forged).kind).toBe('enqueue');
    expect(commitReliableIngress(receiver, [])).toEqual([]);
    releaseUncommittedReliableIngress(receiver, [forged], []);
    expect(receiver.runtimeState?.pendingReliableIngress?.size).toBe(0);

    expect(registerReliableIngress(receiver, sender.runtimeId!, honest).kind).toBe('enqueue');
    const commits = commitReliableIngress(receiver, []);
    expect(commits).toHaveLength(1);
    expect(commits[0]?.receipt?.body.coverage).toBe('terminal');
    expect(commits[0]?.receipt?.body.identity.frameHash).not.toBe('');
  });

  test('only an applied, fully authenticated stale J-prefix vote receives a terminal ACK', () => {
    const source = runtime('reliable-receipt-signed-stale-source');
    const receiver = runtime('reliable-receipt-signed-stale-receiver');
    const output = signedStaleJPrefixOutput(receiver, source);
    installStaleJPrefixAuthority(receiver, output);

    expect(registerReliableIngress(receiver, source.runtimeId!, output).kind).toBe('enqueue');
    expect(commitReliableIngress(receiver, [])).toEqual([]);

    const commits = commitReliableIngress(receiver, [output]);
    expect(commits).toHaveLength(1);
    expect(commits[0]?.receipt?.body.coverage).toBe('terminal');
    finalizeReliableIngressCommit(receiver, commits);
    expect(registerReliableIngress(receiver, source.runtimeId!, output).kind).toBe('receipt');

    const forgedReceiver = runtime('reliable-receipt-forged-stale-receiver');
    const forged = structuredClone(signedStaleJPrefixOutput(forgedReceiver, source));
    const forgedAttestation = forged.jPrefixAttestations?.values().next().value;
    if (!forgedAttestation) throw new Error('TEST_FORGED_STALE_J_PREFIX_MISSING');
    forgedAttestation.signature = `${forgedAttestation.signature.slice(0, -2)}ff`;
    installStaleJPrefixAuthority(forgedReceiver, forged);
    expect(registerReliableIngress(forgedReceiver, source.runtimeId!, forged).kind).toBe('enqueue');
    expect(() => commitReliableIngress(forgedReceiver, [forged]))
      .toThrow('J_PREFIX_SIGNATURE_REJECTED');
    expect(forgedReceiver.runtimeState?.reliableIngressTerminalWatermarks?.size ?? 0).toBe(0);
  });

  test('poisoned same-hash Entity body cannot suppress the honest proposal', () => {
    const sender = runtime('reliable-receipt-sender-body-poison');
    const receiver = runtime('reliable-receipt-receiver-body-poison');
    const withProvider = (provider: string): DeliverableEntityInput => {
      const output = frameOutput(receiver.runtimeId!);
      output.proposedFrame!.txs = [{
        type: 'chatMessage',
        data: {
          message: 'same claimed hash, different body',
          timestamp: 7,
          metadata: { type: 'provider-test', provider },
        },
      }];
      return output;
    };
    const poisoned = withProvider('beta');
    const honest = withProvider('alpha');

    expect(registerReliableIngress(receiver, sender.runtimeId!, poisoned).kind).toBe('enqueue');
    expect(() => registerReliableIngress(receiver, sender.runtimeId!, honest))
      .toThrow('RELIABLE_INGRESS_ENTITY_FRAME_BODY_CONFLICT');
    expect(receiver.runtimeState?.pendingReliableIngress?.size).toBe(1);
  });

  test('proposal receipt does not ACK or GC a later certificate for the same frame', () => {
    const sender = runtime('reliable-receipt-sender-proposal-certificate');
    const receiver = runtime('reliable-receipt-receiver-proposal-certificate');
    const proposal = frameOutput(receiver.runtimeId!);
    const proposalCommits = commitAtReceiver(receiver, sender.runtimeId!, proposal);
    finalizeReliableIngressCommit(receiver, proposalCommits);
    sender.pendingNetworkOutputs = [proposal];
    expect(applyReliableDeliveryReceipts(sender, [proposalCommits[0]!.receipt])).toEqual({ removed: 1 });

    const certificate = frameOutput(
      receiver.runtimeId!,
      7,
      `0x${'ab'.repeat(32)}`,
      ['0xentity-quorum-hanko'],
    );
    sender.pendingNetworkOutputs = [certificate];
    expect(registerReliableIngress(receiver, sender.runtimeId!, certificate).kind).toBe('enqueue');
    const certificateCommits = commitApplied(receiver, [certificate]);
    finalizeReliableIngressCommit(receiver, certificateCommits);

    expect(certificateCommits[0]!.receipt.body.identity.evidenceKind).toBe('entity-certificate');
    expect(certificateCommits[0]!.receipt.body.identity.evidenceDigest)
      .not.toBe(proposalCommits[0]!.receipt.body.identity.evidenceDigest);
    expect(applyReliableDeliveryReceipts(sender, [certificateCommits[0]!.receipt])).toEqual({ removed: 1 });
    expect(registerReliableIngress(receiver, sender.runtimeId!, certificate).kind).toBe('receipt');
    expect(receiverFrontierCount(receiver)).toBe(1);
    expect(senderFrontierCount(sender)).toBe(1);
  });

  test('plain ACK then frame_ack apply durably in order and GC only their exact sender outputs', () => {
    const sender = runtime('reliable-receipt-sender-account-ack-variants');
    const receiver = runtime('reliable-receipt-receiver-account-ack-variants');
    const plain = accountAckOutput(receiver.runtimeId!);
    const richer = accountFrameAckOutput(receiver.runtimeId!);
    sender.pendingNetworkOutputs = [plain, richer];

    const plainCommits = commitAtReceiver(receiver, sender.runtimeId!, plain);
    finalizeReliableIngressCommit(receiver, plainCommits);
    const richerCommits = commitAtReceiver(receiver, sender.runtimeId!, richer);
    finalizeReliableIngressCommit(receiver, richerCommits);

    expect(plainCommits[0]!.receipt.body.identity.evidenceKind).toBe('account-ack');
    expect(richerCommits[0]!.receipt.body.identity.evidenceKind).toBe('account-frame-ack');
    expect(applyReliableDeliveryReceipts(sender, [plainCommits[0]!.receipt]))
      .toEqual({ removed: 1 });
    expect(sender.pendingNetworkOutputs).toEqual([richer]);
    expect(applyReliableDeliveryReceipts(sender, [richerCommits[0]!.receipt]))
      .toEqual({ removed: 1 });
    expect(sender.pendingNetworkOutputs).toEqual([]);
    expect(receiverFrontierCount(receiver)).toBe(1);
  });

  test('frame_ack rejects same-variant equivocation and any later plain-ACK regression', () => {
    const sender = runtime('reliable-receipt-sender-account-ack-equivocation');
    const receiver = runtime('reliable-receipt-receiver-account-ack-equivocation');
    const richer = accountFrameAckOutput(receiver.runtimeId!);

    expect(registerReliableIngress(receiver, sender.runtimeId!, richer).kind).toBe('enqueue');
    expect(() => registerReliableIngress(
      receiver,
      sender.runtimeId!,
      accountFrameAckOutput(receiver.runtimeId!, 7, '0xconflicting-proposal-state-8'),
    )).toThrow('RELIABLE_INGRESS_EVIDENCE_CONFLICT');
    expect(registerReliableIngress(
      receiver,
      sender.runtimeId!,
      accountAckOutput(receiver.runtimeId!),
    ).kind).toBe('pending');

    const commits = commitApplied(receiver, [richer]);
    finalizeReliableIngressCommit(receiver, commits);
    expect(registerReliableIngress(
      receiver,
      sender.runtimeId!,
      accountAckOutput(receiver.runtimeId!),
    ).kind).toBe('receipt');
  });

  test('durable frame_ack H does not block the H+1 ACK required to commit its pending frame', () => {
    const sender = runtime('reliable-receipt-sender-account-ack-successor');
    const receiverSeed = 'reliable-receipt-receiver-account-ack-successor';
    const receiver = runtime(receiverSeed);
    const first = accountFrameAckOutput(receiver.runtimeId!, 1, '0xaccount-frame-2');
    const successor = accountFrameAckOutput(receiver.runtimeId!, 2, '0xaccount-frame-3');

    expect(registerReliableIngress(receiver, sender.runtimeId!, first).kind).toBe('enqueue');
    ensureAppliedAuthority(receiver, first);
    const replica = receiver.eReplicas.get(`${first.entityId}:${first.signerId}`);
    if (!replica) throw new Error('TEST_ACCOUNT_SUCCESSOR_REPLICA_MISSING');
    replica.state.accounts.set(entityId('d1'), {
      leftEntity: entityId('d1'),
      rightEntity: first.entityId,
      currentHeight: 1,
      currentFrame: {
        height: 1,
        stateHash: '0xaccount-frame-1',
      },
      pendingFrame: {
        height: 2,
        prevFrameHash: '0xaccount-frame-1',
        stateHash: '0xaccount-frame-2',
      },
      mempool: [],
    } as never);
    const account = replica.state.accounts.get(entityId('d1'));
    if (!account) throw new Error('TEST_ACCOUNT_SUCCESSOR_ACCOUNT_MISSING');
    const firstCommits = commitReliableIngress(receiver, [first]);
    finalizeReliableIngressCommit(receiver, firstCommits);

    expect(firstCommits[0]?.receipt?.body).toMatchObject({
      coverage: 'exact',
      identity: { height: 1, evidenceKind: 'account-frame-ack' },
    });
    const beforeSuccessorApply = buildDurableRuntimeMachineSnapshot(receiver);
    const restartedBeforeApply = runtime(receiverSeed);
    restoreDurableRuntimeSnapshot(restartedBeforeApply, beforeSuccessorApply);
    expect(registerReliableIngress(
      restartedBeforeApply,
      sender.runtimeId!,
      successor,
    ).kind).toBe('enqueue');
    expect(registerReliableIngress(
      restartedBeforeApply,
      sender.runtimeId!,
      accountFrameAckOutput(receiver.runtimeId!, 3, '0xaccount-frame-4'),
    ).kind).toBe('pending');

    expect(registerReliableIngress(receiver, sender.runtimeId!, successor).kind).toBe('enqueue');
    expect(() => registerReliableIngress(
      receiver,
      sender.runtimeId!,
      accountFrameAckOutput(receiver.runtimeId!, 2, '0xconflicting-account-frame-3'),
    )).toThrow('RELIABLE_INGRESS_EVIDENCE_CONFLICT');
    ensureAppliedAuthority(receiver, successor);
    account.currentHeight = 2;
    account.currentFrame = {
      height: 2,
      prevFrameHash: '0xaccount-frame-1',
      stateHash: '0xaccount-frame-2',
    } as never;
    account.pendingFrame = {
      height: 3,
      prevFrameHash: '0xaccount-frame-2',
      stateHash: '0xaccount-frame-3',
    } as never;

    const successorCommits = commitReliableIngress(receiver, [successor]);
    const successorDeliveries = finalizeReliableIngressCommit(receiver, successorCommits);

    expect(successorCommits).toHaveLength(2);
    expect(successorDeliveries).toHaveLength(1);
    expect(successorDeliveries[0]?.receipt.body).toMatchObject({
      coverage: 'exact',
      identity: { height: 2, evidenceKind: 'account-frame-ack' },
    });
    expect(receiver.runtimeState?.reliableIngressTerminalWatermarks?.values().next().value?.body.identity)
      .toMatchObject({ height: 1, evidenceKind: 'account-frame-ack' });
    expect(receiver.runtimeState?.reliableIngressReceiptLedger?.values().next().value?.body.identity)
      .toMatchObject({ height: 2, evidenceKind: 'account-frame-ack' });
    expect(receiver.runtimeState?.pendingReliableIngress?.size ?? 0).toBe(0);

    const afterSuccessorApply = buildDurableRuntimeMachineSnapshot(receiver);
    const restartedAfterApply = runtime(receiverSeed);
    restoreDurableRuntimeSnapshot(restartedAfterApply, afterSuccessorApply);
    const retry = registerReliableIngress(restartedAfterApply, sender.runtimeId!, successor);
    expect(retry.kind).toBe('receipt');
    if (retry.kind !== 'receipt') throw new Error('TEST_ACCOUNT_SUCCESSOR_RETRY_RECEIPT_MISSING');
    expect(retry.receipt.body.identity).toMatchObject({
      height: 2,
      evidenceKind: 'account-frame-ack',
    });
  });

  test('terminal plain ACK reissues a richer terminal receipt only when its proposal is already committed', () => {
    const sender = runtime('reliable-receipt-sender-terminal-plain-rich-reissue');
    const receiver = runtime('reliable-receipt-receiver-terminal-plain-rich-reissue');
    const plain = accountAckOutput(receiver.runtimeId!, 7);
    const richer = accountFrameAckOutput(receiver.runtimeId!, 7, '0xproposal-state-8');
    const [plainCommit] = commitTerminalAccountAtReceiver(
      receiver,
      sender.runtimeId!,
      plain,
      7,
      '0xaccount-frame-7',
    );
    if (!plainCommit?.receipt) throw new Error('TEST_TERMINAL_PLAIN_RECEIPT_MISSING');
    const replica = receiver.eReplicas.get(`${plain.entityId}:${plain.signerId}`);
    const account = replica?.state.accounts.get(entityId('d1'));
    if (!account) throw new Error('TEST_TERMINAL_PLAIN_ACCOUNT_MISSING');
    account.currentHeight = 8;
    account.currentFrame = {
      height: 8,
      prevFrameHash: '0xaccount-frame-7',
      stateHash: '0xproposal-state-8',
    } as never;
    delete account.pendingFrame;
    const activeBefore = receiver.runtimeState?.reliableIngressReceiptLedger?.size ?? 0;
    const pendingBefore = receiver.runtimeState?.pendingReliableIngress?.size ?? 0;

    const registration = registerReliableIngress(receiver, sender.runtimeId!, richer);

    expect(registration.kind).toBe('receipt');
    if (registration.kind !== 'receipt') throw new Error('TEST_TERMINAL_RICH_RECEIPT_MISSING');
    expect(registration.receipt.body).toMatchObject({
      coverage: 'terminal',
      identity: {
        height: 7,
        evidenceKind: 'account-frame-ack',
      },
    });
    expect(registration.receipt.body.identity.evidenceDigest)
      .not.toBe(plainCommit.receipt.body.identity.evidenceDigest);
    expect(receiver.runtimeState?.reliableIngressReceiptLedger?.size ?? 0).toBe(activeBefore);
    expect(receiver.runtimeState?.pendingReliableIngress?.size ?? 0).toBe(pendingBefore);
  });

  test('terminal plain ACK rejects a richer same-height proposal that conflicts with committed state', () => {
    const sender = runtime('reliable-receipt-sender-terminal-plain-rich-conflict');
    const receiver = runtime('reliable-receipt-receiver-terminal-plain-rich-conflict');
    const plain = accountAckOutput(receiver.runtimeId!, 7);
    commitTerminalAccountAtReceiver(
      receiver,
      sender.runtimeId!,
      plain,
      7,
      '0xaccount-frame-7',
    );
    const replica = receiver.eReplicas.get(`${plain.entityId}:${plain.signerId}`);
    const account = replica?.state.accounts.get(entityId('d1'));
    if (!account) throw new Error('TEST_TERMINAL_PLAIN_CONFLICT_ACCOUNT_MISSING');
    account.currentHeight = 8;
    account.currentFrame = {
      height: 8,
      prevFrameHash: '0xaccount-frame-7',
      stateHash: '0xcommitted-proposal-state-8',
    } as never;
    delete account.pendingFrame;

    expect(() => registerReliableIngress(
      receiver,
      sender.runtimeId!,
      accountFrameAckOutput(receiver.runtimeId!, 7, '0xconflicting-proposal-state-8'),
    )).toThrow('RELIABLE_INGRESS_TERMINAL_ACCOUNT_FRAME_CONFLICT');
    const conflictingAckBody = accountFrameAckOutput(
      receiver.runtimeId!,
      7,
      '0xcommitted-proposal-state-8',
    );
    const conflictingAckTx = conflictingAckBody.entityTxs?.[0];
    if (!conflictingAckTx || conflictingAckTx.type !== 'accountInput') {
      throw new Error('TEST_TERMINAL_PLAIN_CONFLICT_ACK_MISSING');
    }
    conflictingAckTx.data.ack.frameHash = '0xconflicting-account-frame-7';
    expect(() => registerReliableIngress(
      receiver,
      sender.runtimeId!,
      conflictingAckBody,
    )).toThrow('RELIABLE_FRONTIER_LANE_ORDER_CONFLICT:account-ack:7');
    expect(receiver.runtimeState?.reliableIngressReceiptLedger?.size ?? 0).toBe(0);
    expect(receiver.runtimeState?.pendingReliableIngress?.size ?? 0).toBe(0);
  });

  test('terminal plain ACK never infers richer proposal ancestry beyond exact H+1', () => {
    const sender = runtime('reliable-receipt-sender-terminal-plain-rich-no-ancestry');
    const receiver = runtime('reliable-receipt-receiver-terminal-plain-rich-no-ancestry');
    const plain = accountAckOutput(receiver.runtimeId!, 7);
    commitTerminalAccountAtReceiver(
      receiver,
      sender.runtimeId!,
      plain,
      7,
      '0xaccount-frame-7',
    );
    const replica = receiver.eReplicas.get(`${plain.entityId}:${plain.signerId}`);
    const account = replica?.state.accounts.get(entityId('d1'));
    if (!account) throw new Error('TEST_TERMINAL_PLAIN_NO_ANCESTRY_ACCOUNT_MISSING');
    account.currentHeight = 9;
    account.currentFrame = {
      height: 9,
      prevFrameHash: '0xaccount-frame-8',
      stateHash: '0xaccount-frame-9',
    } as never;

    expect(registerReliableIngress(
      receiver,
      sender.runtimeId!,
      accountFrameAckOutput(receiver.runtimeId!, 7, '0xproposal-state-8'),
    ).kind).toBe('enqueue');
    expect(receiver.runtimeState?.pendingReliableIngress?.size ?? 0).toBe(1);
  });

  test('receiver serializes same-lane variants but not independent protocol kinds', () => {
    const sender = runtime('reliable-receipt-sender-receiver-hol');
    const receiver = runtime('reliable-receipt-receiver-receiver-hol');
    const proposal = frameOutput(receiver.runtimeId!);
    const certificate = frameOutput(
      receiver.runtimeId!,
      7,
      `0x${'ab'.repeat(32)}`,
      ['0xentity-quorum-hanko'],
    );

    expect(registerReliableIngress(receiver, sender.runtimeId!, proposal).kind).toBe('enqueue');
    expect(registerReliableIngress(receiver, sender.runtimeId!, certificate).kind).toBe('pending');
    expect(registerReliableIngress(receiver, sender.runtimeId!, accountAckOutput(receiver.runtimeId!)).kind)
      .toBe('enqueue');

    const proposalCommits = commitApplied(receiver, [proposal]);
    finalizeReliableIngressCommit(receiver, proposalCommits);
    expect(registerReliableIngress(receiver, sender.runtimeId!, certificate).kind).toBe('enqueue');
  });

  test('receiver head-of-line blocking is scoped to one Entity lane', () => {
    const sender = runtime('reliable-receipt-sender-entity-lane-hol');
    const receiver = runtime('reliable-receipt-receiver-entity-lane-hol');
    const entityAProposal = frameOutput(receiver.runtimeId!);
    const entityACertificate = frameOutput(
      receiver.runtimeId!,
      7,
      `0x${'ab'.repeat(32)}`,
      ['0xentity-quorum-hanko'],
    );
    const entityBProposal = {
      ...frameOutput(receiver.runtimeId!, 7, `0x${'bc'.repeat(32)}`),
      entityId: entityId('b3'),
    };

    expect(registerReliableIngress(receiver, sender.runtimeId!, entityAProposal).kind).toBe('enqueue');
    expect(registerReliableIngress(receiver, sender.runtimeId!, entityACertificate).kind).toBe('pending');
    expect(registerReliableIngress(receiver, sender.runtimeId!, entityBProposal).kind).toBe('enqueue');
  });

  test('receiver blocks H+1 after a durable proposal until its certificate is durable', () => {
    const sender = runtime('reliable-receipt-sender-receiver-terminal-hol');
    const receiver = runtime('reliable-receipt-receiver-receiver-terminal-hol');
    const proposal = frameOutput(receiver.runtimeId!, 7);
    const proposalCommits = commitAtReceiver(receiver, sender.runtimeId!, proposal);
    finalizeReliableIngressCommit(receiver, proposalCommits);

    const nextProposal = frameOutput(receiver.runtimeId!, 8, `0x${'ac'.repeat(32)}`);
    expect(registerReliableIngress(receiver, sender.runtimeId!, nextProposal).kind).toBe('pending');

    const certificate = frameOutput(
      receiver.runtimeId!,
      7,
      `0x${'ab'.repeat(32)}`,
      ['0xentity-quorum-hanko'],
    );
    const certificateCommits = commitAtReceiver(receiver, sender.runtimeId!, certificate);
    finalizeReliableIngressCommit(receiver, certificateCommits);
    expect(registerReliableIngress(receiver, sender.runtimeId!, nextProposal).kind).toBe('enqueue');
  });

  test('an unfinalized higher J range never cumulatively ACKs a missing lower range', () => {
    const sender = runtime('reliable-receipt-sender-j-order-gap');
    const receiver = runtime('reliable-receipt-receiver-j-order-gap');
    const higher = jFinalityOutput(receiver.runtimeId!, 100);
    const missingLower = jFinalityOutput(receiver.runtimeId!, 50);

    const commits = commitAtReceiver(receiver, sender.runtimeId!, higher);
    finalizeReliableIngressCommit(receiver, commits);

    expect(commits[0]!.receipt!.body.coverage).toBe('exact');
    expect(() => registerReliableIngress(receiver, sender.runtimeId!, missingLower))
      .toThrow('RELIABLE_INGRESS_OPEN_FRONTIER_ORDER_GAP:j-finality:100:50');
    expect(receiver.runtimeState?.reliableIngressTerminalWatermarks?.size ?? 0).toBe(0);
  });

  test('a finalized J watermark exact-ACKs every fully stale linked-list range', () => {
    const sender = runtime('reliable-receipt-sender-j-certified-prefix');
    const receiver = runtime('reliable-receipt-receiver-j-certified-prefix');
    const higher = jFinalityOutput(receiver.runtimeId!, 100, EMPTY_J_HISTORY_ROOT);
    const commits = commitAtReceiver(receiver, sender.runtimeId!, higher);
    finalizeReliableIngressCommit(receiver, commits);
    const replica = receiver.eReplicas.values().next().value as EntityReplica;
    const tx = higher.entityTxs![0]!;
    if (tx.type !== 'j_event') throw new Error('TEST_J_FINALITY_TX_MISSING');
    const data = tx.data;
    const certifiedLower = jFinalityOutput(receiver.runtimeId!, 50, EMPTY_J_HISTORY_ROOT);
    const certifiedLowerTx = certifiedLower.entityTxs![0]!;
    if (certifiedLowerTx.type !== 'j_event') throw new Error('TEST_J_LOWER_FINALITY_TX_MISSING');
    replica.state.lastFinalizedJHeight = 100;
    replica.state.jBlockChain = [];
    replica.state.jHistoryFinality = {
      jurisdictionRef: data.jurisdictionRef,
      baseHeight: data.baseHeight,
      finalizedThroughHeight: 100,
      tipBlockHash: data.tipBlockHash,
      eventHistoryRoot: EMPTY_J_HISTORY_ROOT,
      proposerSignerId: data.from,
      proposerSignature: data.signature,
      entityHeight: 1,
    };

    expect(commitReliableIngress(receiver, [])).toHaveLength(1);
    expect(receiver.runtimeState?.reliableIngressReceiptLedger?.size ?? 0).toBe(0);
    expect(receiver.runtimeState?.reliableIngressTerminalWatermarks?.size).toBe(1);

    const conflictingLower = jFinalityOutput(
      receiver.runtimeId!,
      50,
      `0x${'ff'.repeat(32)}`,
    );
    const conflictingLowerReceipt = registerReliableIngress(
      receiver,
      sender.runtimeId!,
      conflictingLower,
    );
    expect(conflictingLowerReceipt.kind).toBe('receipt');
    const matchingLowerReceipt = registerReliableIngress(
      receiver,
      sender.runtimeId!,
      certifiedLower,
    );
    expect(matchingLowerReceipt.kind).toBe('receipt');
    if (matchingLowerReceipt.kind !== 'receipt') throw new Error('TEST_J_EXACT_RECEIPT_MISSING');
    expect(matchingLowerReceipt.receipt.body.coverage).toBe('exact');
    expect(matchingLowerReceipt.receipt.body.identity.height).toBe(50);
  });

  test('sender terminal J receipt never GCs a conflicting lower range without exact prefix proof', () => {
    const sender = runtime('reliable-receipt-sender-j-sender-prefix');
    const receiver = runtime('reliable-receipt-receiver-j-sender-prefix');
    const higher = jFinalityOutput(receiver.runtimeId!, 100, EMPTY_J_HISTORY_ROOT);
    const commits = commitAtReceiver(receiver, sender.runtimeId!, higher);
    finalizeReliableIngressCommit(receiver, commits);
    const replica = receiver.eReplicas.values().next().value as EntityReplica;
    const tx = higher.entityTxs![0]!;
    if (tx.type !== 'j_event') throw new Error('TEST_J_FINALITY_TX_MISSING');
    const matchingLower = jFinalityOutput(receiver.runtimeId!, 50, EMPTY_J_HISTORY_ROOT);
    const matchingLowerTx = matchingLower.entityTxs![0]!;
    if (matchingLowerTx.type !== 'j_event') throw new Error('TEST_J_LOWER_FINALITY_TX_MISSING');
    replica.state.lastFinalizedJHeight = 100;
    replica.state.jBlockChain = [];
    replica.state.jHistoryFinality = {
      jurisdictionRef: tx.data.jurisdictionRef,
      baseHeight: tx.data.baseHeight,
      finalizedThroughHeight: 100,
      tipBlockHash: tx.data.tipBlockHash,
      eventHistoryRoot: EMPTY_J_HISTORY_ROOT,
      proposerSignerId: tx.data.from,
      proposerSignature: tx.data.signature,
      entityHeight: 1,
    };
    commitReliableIngress(receiver, []);
    const terminal = receiver.runtimeState?.reliableIngressTerminalWatermarks?.values().next().value;
    if (!terminal) throw new Error('TEST_J_TERMINAL_RECEIPT_MISSING');
    const conflictingLower = jFinalityOutput(receiver.runtimeId!, 50, `0x${'ff'.repeat(32)}`);
    sender.pendingNetworkOutputs = [conflictingLower, higher];

    expect(applyReliableDeliveryReceipts(sender, [terminal])).toEqual({ removed: 1 });
    expect(sender.pendingNetworkOutputs).toEqual([conflictingLower]);

    const lowerRegistration = registerReliableIngress(
      receiver,
      sender.runtimeId!,
      matchingLower,
    );
    if (lowerRegistration.kind !== 'receipt') throw new Error('TEST_J_EXACT_RECEIPT_MISSING');
    const exactLower = lowerRegistration.receipt;
    for (const [index, receipts] of [
      [terminal, exactLower],
      [exactLower, terminal],
    ].entries()) {
      const batchSender = runtime(`reliable-receipt-sender-j-batch-order-${index}`);
      batchSender.pendingNetworkOutputs = [matchingLower, higher];
      expect(applyReliableDeliveryReceipts(batchSender, receipts)).toEqual({ removed: 2 });
      expect(batchSender.pendingNetworkOutputs).toEqual([]);
      expect(batchSender.runtimeState?.receivedReliableTerminalWatermarks?.size).toBe(1);
      expect(batchSender.runtimeState?.receivedReliableReceiptLedger?.size).toBe(0);
    }
  });

  test('higher linked-list finality terminalizes an already-applied lower range', () => {
    const sender = runtime('reliable-receipt-sender-j-refresh-conflict');
    const receiver = runtime('reliable-receipt-receiver-j-refresh-conflict');
    const conflictingLower = jFinalityOutput(
      receiver.runtimeId!,
      50,
      `0x${'ff'.repeat(32)}`,
    );
    const commits = commitAtReceiver(receiver, sender.runtimeId!, conflictingLower);
    finalizeReliableIngressCommit(receiver, commits);
    const replica = receiver.eReplicas.values().next().value as EntityReplica;
    const tx = conflictingLower.entityTxs![0]!;
    if (tx.type !== 'j_event') throw new Error('TEST_J_FINALITY_TX_MISSING');
    replica.state.lastFinalizedJHeight = 100;
    replica.state.jBlockChain = [];
    replica.state.jHistoryFinality = {
      jurisdictionRef: tx.data.jurisdictionRef,
      baseHeight: 0,
      finalizedThroughHeight: 100,
      tipBlockHash: `0x${'64'.padStart(64, '0')}`,
      eventHistoryRoot: EMPTY_J_HISTORY_ROOT,
      proposerSignerId: tx.data.from,
      proposerSignature: tx.data.signature,
      entityHeight: 1,
    };

    expect(commitReliableIngress(receiver, [])).toHaveLength(1);
    expect(receiver.runtimeState?.reliableIngressReceiptLedger?.size).toBe(0);
    expect(receiver.runtimeState?.reliableIngressTerminalWatermarks?.size).toBe(1);
  });

  test('sparse and richer precommit evidence apply once each while signer equivocation fails closed', () => {
    const sender = runtime('reliable-receipt-sender-precommit-enrichment');
    const receiver = runtime('reliable-receipt-receiver-precommit-enrichment');
    const validatorA = signerId('c1');
    const validatorB = signerId('c2');
    const sparse = precommitOutput(receiver.runtimeId!, [[validatorA, ['0xsig-a']]]);
    sender.pendingNetworkOutputs = [sparse];
    const sparseCommits = commitAtReceiver(receiver, sender.runtimeId!, sparse);
    finalizeReliableIngressCommit(receiver, sparseCommits);
    expect(applyReliableDeliveryReceipts(sender, [sparseCommits[0]!.receipt])).toEqual({ removed: 1 });

    const richer = precommitOutput(receiver.runtimeId!, [
      [validatorA, ['0xsig-a']],
      [validatorB, ['0xsig-b']],
    ]);
    sender.pendingNetworkOutputs = [richer];
    expect(registerReliableIngress(receiver, sender.runtimeId!, richer).kind).toBe('enqueue');
    const richerCommits = commitApplied(receiver, [richer]);
    finalizeReliableIngressCommit(receiver, richerCommits);
    expect(applyReliableDeliveryReceipts(sender, [richerCommits[0]!.receipt])).toEqual({ removed: 1 });
    expect(registerReliableIngress(receiver, sender.runtimeId!, richer).kind).toBe('receipt');

    const conflicting = precommitOutput(receiver.runtimeId!, [[validatorA, ['0xsig-equivocation']]]);
    expect(() => registerReliableIngress(receiver, sender.runtimeId!, conflicting))
      .toThrow('RELIABLE_INGRESS_EVIDENCE_CONFLICT');
    expect(receiverFrontierCount(receiver)).toBe(1);
    expect(senderFrontierCount(sender)).toBe(1);

    const regressiveSubset = precommitOutput(receiver.runtimeId!, [[validatorB, ['0xsig-b']]]);
    expect(registerReliableIngress(receiver, sender.runtimeId!, regressiveSubset).kind).toBe('receipt');
  });

  test('terminal precommit frontier unions independent validator bindings at one committed height', () => {
    const sender = runtime('reliable-receipt-sender-terminal-precommit-union');
    const receiver = runtime('reliable-receipt-receiver-terminal-precommit-union');
    const validatorA = signerId('c1');
    const validatorB = signerId('c2');
    const frameHash = `0x${'ab'.repeat(32)}`;
    const first = precommitOutput(receiver.runtimeId!, [[validatorA, ['0xsig-a']]], 7, frameHash);

    expect(registerReliableIngress(receiver, sender.runtimeId!, first).kind).toBe('enqueue');
    ensureAppliedAuthority(receiver, first);
    const replica = receiver.eReplicas.get(`${first.entityId}:${first.signerId}`)!;
    replica.state.height = 7;
    replica.state.prevFrameHash = frameHash;
    const firstCommits = commitReliableIngress(receiver, [first]);
    finalizeReliableIngressCommit(receiver, firstCommits);
    expect(firstCommits[0]!.receipt?.body.coverage).toBe('terminal');

    const second = precommitOutput(receiver.runtimeId!, [[validatorB, ['0xsig-b']]], 7, frameHash);
    expect(registerReliableIngress(receiver, sender.runtimeId!, second).kind).toBe('enqueue');
    const secondCommits = commitApplied(receiver, [second]);
    finalizeReliableIngressCommit(receiver, secondCommits);
    expect(secondCommits[0]!.receipt?.body.identity.evidenceBindings).toEqual([
      expect.objectContaining({ subject: validatorA }),
      expect.objectContaining({ subject: validatorB }),
    ]);

    const conflicting = precommitOutput(
      receiver.runtimeId!,
      [[validatorA, ['0xsig-equivocation']]],
      7,
      frameHash,
    );
    expect(() => registerReliableIngress(receiver, sender.runtimeId!, conflicting))
      .toThrow('EVIDENCE_CONFLICT');
  });

  test('sender GCs only the exact output after an authenticated durable receipt', () => {
    const sender = runtime('reliable-receipt-sender-d');
    const receiver = runtime('reliable-receipt-receiver-d');
    const output = frameOutput(receiver.runtimeId!);
    sender.pendingNetworkOutputs = [output];
    const commits = commitAtReceiver(receiver, sender.runtimeId!, output);
    finalizeReliableIngressCommit(receiver, commits);

    expect(applyReliableDeliveryReceipts(sender, [commits[0]!.receipt])).toEqual({ removed: 1 });
    expect(sender.pendingNetworkOutputs).toEqual([]);
  });

  test('tampered receipt never GCs sender outbox', () => {
    const sender = runtime('reliable-receipt-sender-e');
    const receiver = runtime('reliable-receipt-receiver-e');
    const output = frameOutput(receiver.runtimeId!);
    sender.pendingNetworkOutputs = [output];
    const commits = commitAtReceiver(receiver, sender.runtimeId!, output);
    finalizeReliableIngressCommit(receiver, commits);
    const tampered = structuredClone(commits[0]!.receipt) as ReliableDeliveryReceipt;
    tampered.body.identity.frameHash = `0x${'ff'.repeat(32)}`;

    expect(() => applyReliableDeliveryReceipts(sender, [tampered]))
      .toThrow('RELIABLE_RECEIPT_SIGNATURE_INVALID');
    expect(sender.pendingNetworkOutputs).toEqual([output]);
  });

  test('terminal Entity H2 receipt does not GC a conflicting lower H1 frameHash', () => {
    const sender = runtime('reliable-receipt-sender-entity-no-implicit-ancestry');
    const receiver = runtime('reliable-receipt-receiver-entity-no-implicit-ancestry');
    const committedH1 = frameOutput(
      receiver.runtimeId!,
      1,
      `0x${'81'.repeat(32)}`,
      ['0xcommitted-hanko-1'],
    );
    const committedH2 = frameOutput(
      receiver.runtimeId!,
      2,
      `0x${'82'.repeat(32)}`,
      ['0xcommitted-hanko-2'],
    );
    const h1Commits = commitAtReceiver(receiver, sender.runtimeId!, committedH1);
    finalizeReliableIngressCommit(receiver, h1Commits);
    const h2Commits = commitAtReceiver(receiver, sender.runtimeId!, committedH2);
    finalizeReliableIngressCommit(receiver, h2Commits);
    const h2Receipt = h2Commits[0]!.receipt!;
    const conflictingH1 = frameOutput(
      receiver.runtimeId!,
      1,
      `0x${'ff'.repeat(32)}`,
      ['0xconflicting-hanko-1'],
    );
    sender.pendingNetworkOutputs = [conflictingH1, committedH2];

    expect(h2Receipt.body.coverage).toBe('terminal');
    expect(() => registerReliableIngress(receiver, sender.runtimeId!, conflictingH1))
      .toThrow('RELIABLE_INGRESS_TERMINAL_ORDER_CONFLICT:entity-frame:1');
    expect(applyReliableDeliveryReceipts(sender, [h2Receipt])).toEqual({ removed: 1 });
    expect(sender.pendingNetworkOutputs).toEqual([conflictingH1]);
  });

  test('terminal Account H2 reissues an exact receipt for a stale lower H1 retry', () => {
    const sender = runtime('reliable-receipt-sender-account-no-implicit-ancestry');
    const receiver = runtime('reliable-receipt-receiver-account-no-implicit-ancestry');
    const committedH1 = accountAckOutput(receiver.runtimeId!, 1);
    const committedH2 = accountAckOutput(receiver.runtimeId!, 2);
    commitTerminalAccountAtReceiver(
      receiver,
      sender.runtimeId!,
      committedH1,
      1,
      '0xaccount-frame-1',
    );
    const h2Commits = commitTerminalAccountAtReceiver(
      receiver,
      sender.runtimeId!,
      committedH2,
      2,
      '0xaccount-frame-2',
    );
    const h2Receipt = h2Commits[0]!.receipt!;
    const conflictingH1 = accountAckOutput(
      receiver.runtimeId!,
      1,
      '0xconflicting-account-frame-1',
    );
    sender.pendingNetworkOutputs = [conflictingH1, committedH2];

    expect(h2Receipt.body.coverage).toBe('terminal');
    const stale = registerReliableIngress(receiver, sender.runtimeId!, conflictingH1);
    expect(stale.kind).toBe('receipt');
    if (stale.kind !== 'receipt') throw new Error('expected stale Account receipt');
    expect(stale.receipt.body.coverage).toBe('terminal');
    expect(stale.receipt.body.identity.frameHash)
      .toBe(getReliableOutputIdentity(conflictingH1)?.frameHash);
    expect(applyReliableDeliveryReceipts(sender, [h2Receipt])).toEqual({ removed: 1 });
    expect(sender.pendingNetworkOutputs).toEqual([conflictingH1]);
    expect(applyReliableDeliveryReceipts(sender, [stale.receipt])).toEqual({ removed: 1 });
    expect(sender.pendingNetworkOutputs).toEqual([]);
  });

  test('terminal watermark advances monotonically while lower identities require exact receipts', () => {
    const sender = runtime('reliable-receipt-sender-terminal-monotonic');
    const receiverSeed = 'reliable-receipt-receiver-terminal-monotonic';
    const receiver = runtime(receiverSeed);
    const h1 = frameOutput(receiver.runtimeId!, 1, `0x${'81'.repeat(32)}`, ['0xhanko-1']);
    const h2 = frameOutput(receiver.runtimeId!, 2, `0x${'82'.repeat(32)}`, ['0xhanko-2']);
    sender.pendingNetworkOutputs = [h1, h2];

    const h1Commits = commitAtReceiver(receiver, sender.runtimeId!, h1);
    finalizeReliableIngressCommit(receiver, h1Commits);
    const h2Commits = commitAtReceiver(receiver, sender.runtimeId!, h2);
    finalizeReliableIngressCommit(receiver, h2Commits);
    const h1Receipt = h1Commits[0]!.receipt!;
    const h2Receipt = h2Commits[0]!.receipt!;

    expect(applyReliableDeliveryReceipts(sender, [h2Receipt])).toEqual({ removed: 1 });
    expect(sender.pendingNetworkOutputs).toEqual([h1]);
    expect(sender.runtimeState?.receivedReliableTerminalWatermarks?.size).toBe(1);
    expect(applyReliableDeliveryReceipts(sender, [h1Receipt])).toEqual({ removed: 1 });
    expect(sender.pendingNetworkOutputs).toEqual([]);
    expect(sender.runtimeState?.receivedReliableTerminalWatermarks?.values().next().value
      ?.body.identity.height).toBe(2);

    const equivocatingReceiver = runtime(receiverSeed);
    const conflictingH2 = frameOutput(
      equivocatingReceiver.runtimeId!,
      2,
      `0x${'83'.repeat(32)}`,
      ['0xconflicting-hanko-2'],
    );
    const conflictingCommits = commitAtReceiver(
      equivocatingReceiver,
      sender.runtimeId!,
      conflictingH2,
    );
    expect(() => applyReliableDeliveryReceipts(sender, [conflictingCommits[0]!.receipt!]))
      .toThrow('RELIABLE_RECEIPT_LANE_ORDER_CONFLICT');
    expect(sender.runtimeState?.receivedReliableTerminalWatermarks?.values().next().value
      ?.body.identity.frameHash).toBe(h2.proposedFrame!.hash);
  });

  test('delayed exact receipt below a terminal independently ACKs its exact lower identity', () => {
    const sender = runtime('reliable-receipt-sender-cross-coverage');
    const receiverSeed = 'reliable-receipt-receiver-cross-coverage';
    const exactReceiver = runtime(receiverSeed);
    const terminalReceiver = runtime(receiverSeed);
    const h1 = frameOutput(exactReceiver.runtimeId!, 1, `0x${'91'.repeat(32)}`);
    const h2 = frameOutput(terminalReceiver.runtimeId!, 2, `0x${'92'.repeat(32)}`, ['0xhanko-2']);
    sender.pendingNetworkOutputs = [h1, h2];
    const h1Receipt = commitAtReceiver(exactReceiver, sender.runtimeId!, h1)[0]!.receipt!;
    const h2Receipt = commitAtReceiver(terminalReceiver, sender.runtimeId!, h2)[0]!.receipt!;

    expect(h1Receipt.body.coverage).toBe('exact');
    expect(h2Receipt.body.coverage).toBe('terminal');
    expect(applyReliableDeliveryReceipts(sender, [h2Receipt])).toEqual({ removed: 1 });
    expect(sender.pendingNetworkOutputs).toEqual([h1]);
    expect(registerReliableReceiptIngress(sender, h1Receipt)).toBe('enqueue');
    expect(applyReliableDeliveryReceipts(sender, [h1Receipt])).toEqual({ removed: 1 });
    expect(sender.pendingNetworkOutputs).toEqual([]);

    const staleSender = runtime('reliable-receipt-sender-cross-coverage-stale');
    staleSender.pendingNetworkOutputs = [h2];
    expect(applyReliableDeliveryReceipts(staleSender, [h2Receipt])).toEqual({ removed: 1 });
    expect(registerReliableReceiptIngress(staleSender, h1Receipt)).toBe('duplicate');

    const equivocatingReceiver = runtime(receiverSeed);
    const conflictingH2 = frameOutput(
      equivocatingReceiver.runtimeId!,
      2,
      `0x${'93'.repeat(32)}`,
    );
    const conflictingExact = commitAtReceiver(
      equivocatingReceiver,
      sender.runtimeId!,
      conflictingH2,
    )[0]!.receipt!;
    expect(() => registerReliableReceiptIngress(sender, conflictingExact))
      .toThrow('RELIABLE_RECEIPT_LANE_ORDER_CONFLICT');
  });

  test('failed sender WAL commit restores the exact reliable outbox', () => {
    const sender = runtime('reliable-receipt-sender-gc-wal-fail');
    const receiver = runtime('reliable-receipt-receiver-gc-wal-fail');
    const output = frameOutput(receiver.runtimeId!);
    sender.pendingNetworkOutputs = [output];
    const commits = commitAtReceiver(receiver, sender.runtimeId!, output);
    finalizeReliableIngressCommit(receiver, commits);
    const checkpoint = captureReliableReceiptSenderCheckpoint(sender);

    applyReliableDeliveryReceipts(sender, [commits[0]!.receipt]);
    rollbackReliableDeliveryReceipts(sender, checkpoint);

    expect(sender.pendingNetworkOutputs).toEqual([output]);
    expect(sender.runtimeState?.receivedReliableReceiptLedger).toBeUndefined();
  });

  test('duplicate receipt remains idempotent across sender restart', () => {
    const sender = runtime('reliable-receipt-sender-f');
    const receiver = runtime('reliable-receipt-receiver-f');
    const output = frameOutput(receiver.runtimeId!);
    sender.pendingNetworkOutputs = [output];
    const commits = commitAtReceiver(receiver, sender.runtimeId!, output);
    finalizeReliableIngressCommit(receiver, commits);
    applyReliableDeliveryReceipts(sender, [commits[0]!.receipt]);

    const snapshot = buildDurableRuntimeMachineSnapshot(sender);
    const restored = runtime('reliable-receipt-sender-f');
    restoreDurableRuntimeSnapshot(restored, snapshot);
    expect(applyReliableDeliveryReceipts(restored, [commits[0]!.receipt])).toEqual({ removed: 0 });
    expect(restored.pendingNetworkOutputs).toEqual([]);
  });

  test('generic snapshot restore preserves reliable retry evidence byte-for-byte', () => {
    const sender = runtime('reliable-receipt-restored-deadline-sender');
    const receiver = runtime('reliable-receipt-restored-deadline-receiver');
    const output = frameOutput(receiver.runtimeId!);
    const key = buildRouteOutputKey(output);
    sender.pendingNetworkOutputs = [output];
    sender.runtimeState!.deferredNetworkMeta = new Map([[
      key,
      { attempts: 6, nextRetryAt: 99_999_999 },
    ]]);

    const restored = runtime('reliable-receipt-restored-deadline-sender');
    restoreDurableRuntimeSnapshot(restored, buildDurableRuntimeMachineSnapshot(sender));

    expect(restored.pendingNetworkOutputs).toEqual([output]);
    expect(restored.runtimeState?.deferredNetworkMeta?.get(key)).toEqual({
      attempts: 6,
      nextRetryAt: 99_999_999,
    });
  });

  test('transport receipt only GCs through a durable sender RuntimeInput frame', async () => {
    const sender = runtime(`reliable-receipt-sender-runtime-frame-${TEST_RUN_ID}`);
    const receiver = runtime(`reliable-receipt-receiver-runtime-frame-${TEST_RUN_ID}`);
    sender.scenarioMode = true;
    sender.quietRuntimeLogs = true;
    const output = frameOutput(receiver.runtimeId!);
    sender.pendingNetworkOutputs = [output];
    const commits = commitAtReceiver(receiver, sender.runtimeId!, output);
    finalizeReliableIngressCommit(receiver, commits);

    handleInboundReliableReceipt(sender, receiver.runtimeId!, commits[0]!.receipt);
    handleInboundReliableReceipt(sender, receiver.runtimeId!, commits[0]!.receipt);
    expect(sender.runtimeMempool?.reliableReceipts).toHaveLength(1);
    expect(sender.pendingNetworkOutputs).toEqual([output]);

    await processRuntime(sender);

    expect(sender.height).toBe(1);
    expect(sender.pendingNetworkOutputs).toEqual([]);
    expect(sender.runtimeState?.receivedReliableReceiptLedger?.size).toBe(1);
    const durableFrame = await readStorageFrameRecord(getFrameDb(sender), sender.height);
    expect(durableFrame?.runtimeInput.reliableReceipts).toEqual([commits[0]!.receipt]);

    handleInboundReliableReceipt(sender, receiver.runtimeId!, commits[0]!.receipt);
    expect(sender.runtimeMempool?.reliableReceipts ?? []).toEqual([]);
  });

  test('terminal receipt-only ingress advances a replayable Runtime frame before ACK', async () => {
    const sender = runtime(`reliable-receipt-terminal-only-sender-${TEST_RUN_ID}`);
    const receiver = runtime(`reliable-receipt-terminal-only-receiver-${TEST_RUN_ID}`);
    receiver.scenarioMode = true;
    receiver.quietRuntimeLogs = true;
    const fixtureSeed = `reliable-receipt-terminal-only-entity-${TEST_RUN_ID}`;
    const { leaderSignerId, targetSignerId } = registerCatchupFixtureSigners(receiver, fixtureSeed);
    const initialState = createCatchupFixtureState(leaderSignerId, targetSignerId);
    await prepareCatchupFixtureReplica(
      receiver,
      initialState,
      leaderSignerId,
      targetSignerId,
    );
    const certified = await buildCatchupFixtureCertificate(receiver, initialState, 100);
    await processRuntime(receiver, [catchupFixtureDeliverable(
      receiver.runtimeId!,
      initialState.entityId,
      targetSignerId,
      certified.frame,
    )]);
    expect(receiver.eReplicas.get(`${initialState.entityId}:${targetSignerId}`)?.state.height).toBe(1);

    const output = precommitOutput(
      receiver.runtimeId!,
      [[leaderSignerId, certified.frame.collectedSigs.get(leaderSignerId)!]],
      certified.frame.height,
      certified.frame.hash,
    );
    output.entityId = initialState.entityId;
    output.signerId = targetSignerId;

    expect(registerReliableIngress(receiver, sender.runtimeId!, output).kind).toBe('enqueue');
    const replica = receiver.eReplicas.get(`${output.entityId}:${output.signerId}`);
    if (!replica) throw new Error('TEST_TERMINAL_ONLY_REPLICA_MISSING');
    expect(replica.state.prevFrameHash).toBe(certified.frame.hash);

    const heightBefore = receiver.height;
    await processRuntime(receiver, [output]);

    expect(receiver.height).toBe(heightBefore + 1);
    const receiptOnlyFrame = await readStorageFrameRecord(getFrameDb(receiver), receiver.height);
    expect(receiptOnlyFrame?.runtimeInput.entityInputs).toEqual([{
      ...output,
      from: sender.runtimeId,
    }]);
    expect(receiver.runtimeState?.pendingReliableIngress?.size ?? 0).toBe(0);
    expect(receiver.runtimeState?.reliableIngressReceiptLedger?.size ?? 0).toBe(0);
    expect([...(receiver.runtimeState?.reliableIngressTerminalWatermarks?.values() ?? [])]
      .some(receipt => receipt.body.identity.kind === 'hash-precommit')).toBe(true);
  });

  test('releasing only ephemeral deferred ingress does not create an unreplayable Runtime frame', async () => {
    const sender = runtime(`reliable-release-only-sender-${TEST_RUN_ID}`);
    const receiver = runtime(`reliable-release-only-receiver-${TEST_RUN_ID}`);
    receiver.scenarioMode = true;
    receiver.quietRuntimeLogs = true;
    const fixtureSeed = `reliable-release-only-entity-${TEST_RUN_ID}`;
    const { leaderSignerId, targetSignerId } = registerCatchupFixtureSigners(receiver, fixtureSeed);
    const initialState = createCatchupFixtureState(leaderSignerId, targetSignerId);
    await prepareCatchupFixtureReplica(receiver, initialState, leaderSignerId, targetSignerId);
    const certified = await buildCatchupFixtureCertificate(receiver, initialState, 100);
    const futureFrame = structuredClone(certified.frame);
    futureFrame.height = 2;
    futureFrame.parentFrameHash = certified.frame.hash;
    futureFrame.hash = `0x${'fe'.repeat(32)}`;
    const output = catchupFixtureDeliverable(
      receiver.runtimeId!,
      initialState.entityId,
      targetSignerId,
      futureFrame,
    );

    expect(registerReliableIngress(receiver, sender.runtimeId!, output).kind).toBe('enqueue');
    const heightBefore = receiver.height;
    await processRuntime(receiver, [output]);

    expect(receiver.height).toBe(heightBefore);
    expect(receiver.runtimeState?.pendingReliableIngress?.size ?? 0).toBe(0);
    expect(receiver.runtimeState?.reliableIngressReceiptLedger?.size ?? 0).toBe(0);
    expect(receiver.runtimeState?.reliableIngressTerminalWatermarks?.size ?? 0).toBe(0);
  });
});
