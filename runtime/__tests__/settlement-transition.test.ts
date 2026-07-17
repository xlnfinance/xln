import { describe, expect, test } from 'bun:test';

import { applyAccountTx } from '../account/tx/apply';
import { createAccountJClaimSession } from '../account/j-claim-session';
import { cacheCommittedAccountJClaimNodeChanges } from '../account/j-claim-store';
import { prepareAccountJClaimTx } from '../account/j-claim-transition';
import { handleJEventClaim } from '../account/tx/handlers/j-event-claim';
import { createSettlementWorkspaceHash } from '../account/tx/handlers/settle-transition';
import { applyEntityFrame } from '../entity/consensus';
import { computeCanonicalEntityConsensusStateHash } from '../entity/consensus/state-root';
import { buildSignedEntityCommand } from '../entity/command';
import { signedEntityCommandTx } from '../entity/command-codec';
import { buildCollectiveEntityProposalTx } from '../entity/authorization';
import {
  sealHankoWitnessInState,
  type HankoWitnessEntry,
} from '../entity/consensus/hanko-witness';
import { signEntityHashes } from '../hanko/signing';
import { generateLazyEntityId, generateNumberedEntityId } from '../entity/factory';
import {
  canAutoApproveWorkspace,
  buildSettlementSealDraft,
  handleSettleApprove,
  handleSettleExecute,
  handleSettlePropose,
  processCommittedSettlementTransitionFollowup,
  processSettleAction,
} from '../entity/tx/handlers/settle';
import { handleJAbortSentBatch } from '../entity/tx/handlers/j-abort-sent-batch';
import {
  executeCrontab,
  HUB_REBALANCE_INTERVAL_MS,
  initCrontab,
} from '../entity/scheduler';
import { applyFinalizedAccountJEvents } from '../entity/tx/j-events-account';
import { createEmptyBatch, initJBatch } from '../jurisdiction/batch';
import { buildAccountProofBody } from '../protocol/dispute/proof-builder';
import {
  applyCertifiedBoardRegistryEvent,
  cacheCertifiedBoardNodes,
  getCertifiedBoardNodeStore,
} from '../jurisdiction/board-registry';
import { createEmptyEnv } from '../runtime';
import { cloneAccountMachine } from '../state-helpers';
import type { AccountTx, EntityState, Env, HashToSign, JurisdictionConfig, JurisdictionEvent, SettlementOp } from '../types';
import { createDefaultDelta } from '../validation-utils';
import {
  addReplica,
  addr,
  entity,
  makeAccount,
  makeJurisdiction,
  makeState,
  registerTestSigner,
} from './helpers/cross-j';

const LEFT = entity('11');
const RIGHT = entity('22');
const TEST_ACCOUNT_CONTRACT = addr('c1');
const TEST_DELTA_TRANSFORMER = addr('d1');

const transition = (data: Record<string, unknown>): AccountTx => ({
  type: 'settle_transition',
  data,
} as unknown as AccountTx);

const upsert = async (
  account: ReturnType<typeof makeAccount>,
  data: {
    version: number;
    previousWorkspaceHash?: string;
    ops: SettlementOp[];
    executorIsLeft: boolean;
    memo?: string;
  },
) => applyAccountTx(account, transition({ kind: 'upsert', ...data }), true, 1_000);

const signedWorkspaceAccount = async (nonceAtSign: number) => {
  const account = makeAccount(LEFT, RIGHT);
  expect((await upsert(account, {
    version: 1,
    ops: [{ type: 'r2r', tokenId: 1, amount: 4n }],
    executorIsLeft: false,
  })).success).toBe(true);
  account.settlementWorkspace!.leftHanko = '0x1234';
  account.settlementWorkspace!.rightHanko = '0x5678';
  account.settlementWorkspace!.nonceAtSign = nonceAtSign;
  account.settlementWorkspace!.settlementHash = `0x${'81'.repeat(32)}`;
  const proofBodyHash = buildAccountProofBody(account, TEST_DELTA_TRANSFORMER).proofBodyHash;
  account.settlementWorkspace!.postSettlementDisputeProof = {
    leftHanko: '0x9abc',
    rightHanko: '0xdef0',
    disputeHash: `0x${'82'.repeat(32)}`,
    proofBodyHash,
    nonce: nonceAtSign + 1,
  };
  return account;
};

const accountSettledEvent = (nonce: number) => ({
  type: 'AccountSettled' as const,
  data: {
    leftEntity: LEFT,
    rightEntity: RIGHT,
    tokenId: 1,
    leftReserve: '0',
    rightReserve: '0',
    collateral: '0',
    ondelta: '0',
    nonce,
  },
});

const installRegisteredBoard = (
  env: Env,
  state: EntityState,
  jurisdiction: JurisdictionConfig,
  boardHash: string,
): void => {
  const events: JurisdictionEvent[] = [{
    type: 'FoundationBootstrapped',
    data: {
      recipient: addr('f1'),
      boardHash: `0x${'f2'.repeat(32)}`,
      controlTokenId: '2',
      dividendTokenId: '3',
    },
    blockNumber: 1,
    blockHash: `0x${'01'.repeat(32)}`,
    transactionHash: `0x${'11'.repeat(32)}`,
    logIndex: 0,
  }, {
    type: 'EntityRegistered',
    data: {
      entityId: state.entityId,
      entityNumber: BigInt(state.entityId).toString(),
      boardHash,
    },
    blockNumber: 2,
    blockHash: `0x${'02'.repeat(32)}`,
    transactionHash: `0x${'12'.repeat(32)}`,
    logIndex: 0,
  }];
  for (const event of events) {
    const applied = applyCertifiedBoardRegistryEvent(
      state.certifiedBoardState,
      getCertifiedBoardNodeStore(env),
      jurisdiction,
      event,
    );
    cacheCertifiedBoardNodes(env, applied.newNodes);
    state.certifiedBoardState = applied.state;
  }
};

const installProofStack = (env: Env, state: EntityState): void => {
  const jurisdiction = state.config.jurisdiction;
  if (!jurisdiction) throw new Error('TEST_PROOF_JURISDICTION_MISSING');
  if (![...env.eReplicas.values()].some((replica) => replica.entityId === state.entityId)) {
    const signerId = state.config.validators[0];
    if (!signerId) throw new Error('TEST_PROOF_SIGNER_MISSING');
    addReplica(env, state, signerId);
  }
  env.jReplicas.set(jurisdiction.name, {
    name: jurisdiction.name,
    chainId: jurisdiction.chainId,
    depositoryAddress: jurisdiction.depositoryAddress,
    entityProviderAddress: jurisdiction.entityProviderAddress,
    contracts: {
      depository: jurisdiction.depositoryAddress,
      entityProvider: jurisdiction.entityProviderAddress,
      account: TEST_ACCOUNT_CONTRACT,
      deltaTransformer: TEST_DELTA_TRANSFORMER,
    },
    blockNumber: 0n,
    stateRoot: null,
    mempool: [],
    blockDelayMs: 0,
    lastBlockTimestamp: 0,
    position: { x: 0, y: 0, z: 0 },
  });
};

const attachSettlementSealWitness = async (
  env: Env,
  state: EntityState,
  counterpartyId: string,
  tx: Extract<AccountTx, { type: 'settle_transition' }>,
  hashesToSign: readonly HashToSign[],
  entityHeight: number,
): Promise<Extract<AccountTx, { type: 'settle_transition' }>> => {
  const signerId = state.config.validators[0];
  if (!signerId) throw new Error('TEST_SETTLEMENT_SIGNER_MISSING');
  const hankos = await signEntityHashes(
    env,
    state.entityId,
    signerId,
    hashesToSign.map(({ hash }) => hash),
  );
  const witness = new Map<string, HankoWitnessEntry>();
  hashesToSign.forEach((entry, index) => {
    const hanko = hankos[index];
    if (!hanko || (entry.type !== 'settlement' && entry.type !== 'dispute')) {
      throw new Error(`TEST_SETTLEMENT_WITNESS_INVALID:${entry.type}`);
    }
    witness.set(entry.hash, {
      hanko,
      type: entry.type,
      entityHeight,
      createdAt: state.timestamp,
    });
  });
  const account = state.accounts.get(counterpartyId);
  if (!account) throw new Error('TEST_SETTLEMENT_ACCOUNT_MISSING');
  account.mempool.push(tx);
  expect(sealHankoWitnessInState(state, witness, entityHeight)).toBe(hashesToSign.length);
  return account.mempool.at(-1) as Extract<AccountTx, { type: 'settle_transition' }>;
};

describe('atomic settlement Account transition', () => {
  test('hub scheduler waits for the fully sealed settlement state before execute', async () => {
    const env = createEmptyEnv('settlement-transition-scheduler-awaiting-seal');
    const jurisdiction = makeJurisdiction('settlement-transition-scheduler', 31337, 'a1', 'b2');
    const signer = registerTestSigner(env, 'settlement-transition-scheduler-awaiting-seal', '1');
    const state = makeState(LEFT, signer, jurisdiction, RIGHT);
    state.timestamp = HUB_REBALANCE_INTERVAL_MS;
    state.hubRebalanceConfig = {
      matchingStrategy: 'amount',
      policyVersion: 1,
      routingFeePPM: 1,
      baseFee: 0n,
      rebalanceLiquidityFeeBps: 1n,
    };
    state.jBatchState = initJBatch();
    state.crontabState = initCrontab();
    for (const task of state.crontabState.tasks.values()) task.lastRun = state.timestamp;
    state.crontabState.tasks.get('hubRebalance')!.lastRun = 0;
    addReplica(env, state, signer);

    const account = state.accounts.get(RIGHT)!;
    expect((await upsert(account, {
      version: 1,
      ops: [{ type: 'c2r', tokenId: 1, amount: 1n }],
      executorIsLeft: true,
    })).success).toBe(true);
    account.settlementWorkspace!.rightHanko = '0x1234';
    expect(account.settlementWorkspace!.status).toBe('awaiting_counterparty');
    const replica = env.eReplicas.values().next().value;
    if (!replica) throw new Error('SETTLEMENT_SCHEDULER_TEST_REPLICA_MISSING');

    const outputs = await executeCrontab(env, replica, state.crontabState, {
      manualBroadcastInInput: false,
    });

    expect(outputs.flatMap(output => output.entityTxs ?? []).map(tx => tx.type))
      .not.toContain('settle_execute');
  });

  test('hub scheduler does not duplicate a ready settlement while its submit transition is pending', async () => {
    const env = createEmptyEnv('settlement-transition-scheduler-pending-submit');
    const jurisdiction = makeJurisdiction('settlement-transition-scheduler', 31337, 'a1', 'b2');
    const signer = registerTestSigner(env, 'settlement-transition-scheduler-pending-submit', '1');
    const state = makeState(LEFT, signer, jurisdiction, RIGHT);
    state.timestamp = HUB_REBALANCE_INTERVAL_MS;
    state.hubRebalanceConfig = {
      matchingStrategy: 'amount',
      policyVersion: 1,
      routingFeePPM: 1,
      baseFee: 0n,
      rebalanceLiquidityFeeBps: 1n,
    };
    state.jBatchState = initJBatch();
    state.crontabState = initCrontab();
    for (const task of state.crontabState.tasks.values()) task.lastRun = state.timestamp;
    state.crontabState.tasks.get('hubRebalance')!.lastRun = 0;
    addReplica(env, state, signer);

    const account = state.accounts.get(RIGHT)!;
    expect((await upsert(account, {
      version: 1,
      ops: [{ type: 'c2r', tokenId: 1, amount: 1n }],
      executorIsLeft: true,
    })).success).toBe(true);
    const workspace = account.settlementWorkspace!;
    workspace.status = 'ready_to_submit';
    workspace.rightHanko = '0x1234';
    account.mempool.push(transition({
      kind: 'submit',
      version: workspace.version,
      workspaceHash: workspace.workspaceHash,
    }));
    const workspaceBefore = structuredClone(workspace);
    const mempoolBefore = structuredClone(account.mempool);
    const batchBefore = structuredClone(state.jBatchState);
    const replica = env.eReplicas.values().next().value;
    if (!replica) throw new Error('SETTLEMENT_SCHEDULER_TEST_REPLICA_MISSING');

    const outputs = await executeCrontab(env, replica, state.crontabState, {
      manualBroadcastInInput: false,
    });

    expect(outputs.flatMap(output => output.entityTxs ?? []).map(tx => tx.type))
      .not.toContain('settle_execute');
    expect(account.settlementWorkspace).toEqual(workspaceBefore);
    expect(account.mempool).toEqual(mempoolBefore);
    expect(state.jBatchState).toEqual(batchBefore);
  });

  test('legacy direct settlement actions cannot bypass bilateral Account ordering', async () => {
    const account = makeAccount(LEFT, RIGHT);
    await expect(processSettleAction(
      account,
      { type: 'approve' },
      RIGHT,
      LEFT,
      1_000,
    )).rejects.toThrow('SETTLEMENT_DIRECT_ACTION_FORBIDDEN:approve');
    expect(account.settlementWorkspace).toBeUndefined();
    expect(account.mempool).toHaveLength(0);
  });

  test('keeps an unsigned settlement seal queued until its Entity quorum Hanko exists', async () => {
    const env = createEmptyEnv('settlement-transition-two-phase-seal');
    const jurisdiction = makeJurisdiction('settlement-transition-two-phase', 31337, 'a5', 'b6');
    const signerA = registerTestSigner(env, 'settlement-transition-two-phase-seal', '1');
    const signerB = registerTestSigner(env, 'settlement-transition-two-phase-seal', '2');
    const entityA = generateLazyEntityId([signerA], 1n).toLowerCase();
    const entityB = generateLazyEntityId([signerB], 1n).toLowerCase();
    const [leftEntity, rightEntity] = entityA < entityB ? [entityA, entityB] : [entityB, entityA];
    const leftSigner = leftEntity === entityA ? signerA : signerB;
    const rightSigner = rightEntity === entityA ? signerA : signerB;
    const leftState = makeState(leftEntity, leftSigner, jurisdiction, rightEntity);
    const rightState = makeState(rightEntity, rightSigner, jurisdiction, leftEntity);
    addReplica(env, leftState, leftSigner);
    addReplica(env, rightState, rightSigner);
    installProofStack(env, rightState);
    const account = rightState.accounts.get(leftEntity)!;
    expect((await applyAccountTx(account, transition({
      kind: 'upsert',
      version: 1,
      ops: [{ type: 'r2r', tokenId: 1, amount: 4n }],
      executorIsLeft: true,
    }), true, 1_000)).success).toBe(true);

    const approve = {
      type: 'settle_approve',
      data: { counterpartyEntityId: leftEntity, workspaceHash: account.settlementWorkspace!.workspaceHash },
    } as const;
    const proposal = buildCollectiveEntityProposalTx(rightSigner, [approve]);
    const execution = await applyEntityFrame(env, rightState, [
      signedEntityCommandTx(buildSignedEntityCommand(env, rightState, rightSigner, [proposal])),
    ], 2_000);
    const queued = execution.newState.accounts.get(leftEntity)!;

    expect(execution.collectedHashes?.map(({ type }) => type)).toEqual(['settlement', 'dispute']);
    expect(queued.mempool).toHaveLength(1);
    expect(queued.mempool[0]).toMatchObject({
      type: 'settle_transition',
      data: { kind: 'seal' },
    });
    const seal = queued.mempool[0];
    if (seal?.type !== 'settle_transition' || seal.data.kind !== 'seal') {
      throw new Error('TEST_UNSIGNED_SETTLEMENT_SEAL_MISSING');
    }
    expect(seal.data.postProof.hanko).toBeUndefined();
    expect(queued.pendingFrame).toBeUndefined();
    const unsignedEntityStateRoot = computeCanonicalEntityConsensusStateHash(execution.newState);

    const hashesToSign = execution.collectedHashes ?? [];
    const hankos = await signEntityHashes(
      env,
      rightEntity,
      rightSigner,
      hashesToSign.map(({ hash }) => hash),
    );
    const witness = new Map<string, HankoWitnessEntry>();
    hashesToSign.forEach((entry, index) => {
      if (entry.type !== 'settlement' && entry.type !== 'dispute') {
        throw new Error(`TEST_SETTLEMENT_HASH_TYPE_INVALID:${entry.type}`);
      }
      const hanko = hankos[index];
      if (!hanko) throw new Error(`TEST_SETTLEMENT_HANKO_MISSING:${entry.hash}`);
      witness.set(entry.hash, {
        hanko,
        type: entry.type,
        entityHeight: 1,
        createdAt: 2_000,
      });
    });
    expect(sealHankoWitnessInState(execution.newState, witness, 1)).toBe(2);
    expect(seal.data.settlementHanko).toBeDefined();
    expect(seal.data.postProof.hanko).toBeDefined();
    expect(computeCanonicalEntityConsensusStateHash(execution.newState)).toBe(unsignedEntityStateRoot);

    const nextExecution = await applyEntityFrame(env, execution.newState, [], 2_001);
    const proposed = nextExecution.newState.accounts.get(leftEntity)!;
    expect(proposed.mempool).toHaveLength(0);
    expect(proposed.pendingFrame?.accountTxs).toHaveLength(1);
    expect(proposed.pendingFrame?.accountTxs[0]).toEqual(seal);
  });

  test('materializes an exact approval only after earlier Account work drains and uses the first unused nonce', async () => {
    const env = createEmptyEnv('settlement-transition-deferred-fresh-nonce');
    const jurisdiction = makeJurisdiction('settlement-transition-deferred', 31337, 'a6', 'b7');
    const signer = registerTestSigner(env, 'settlement-transition-deferred-fresh-nonce', '1');
    const self = generateLazyEntityId([signer], 1n).toLowerCase();
    const counterparty = entity('45');
    const state = makeState(self, signer, jurisdiction, counterparty);
    addReplica(env, state, signer);
    installProofStack(env, state);
    const account = state.accounts.get(counterparty)!;
    expect((await applyAccountTx(account, transition({
      kind: 'upsert',
      version: 1,
      ops: [{ type: 'r2r', tokenId: 1, amount: 4n }],
      executorIsLeft: true,
    }), true, 1_000)).success).toBe(true);
    account.mempool.push({ type: 'direct_payment', data: { tokenId: 1, amount: 1n } });
    const workspaceHash = account.settlementWorkspace!.workspaceHash;

    const approved = await handleSettleApprove(state, {
      type: 'settle_approve',
      data: { counterpartyEntityId: counterparty, workspaceHash },
    }, env);
    expect(approved.hashesToSign).toBeUndefined();
    expect(approved.newState.deferredAccountProposals?.get(counterparty)).toBe(workspaceHash);
    expect(approved.newState.accounts.get(counterparty)?.mempool).toHaveLength(1);

    const drainedAccount = approved.newState.accounts.get(counterparty)!;
    drainedAccount.mempool = [];
    drainedAccount.proofHeader.nextProofNonce = 6;
    const materialized = await applyEntityFrame(env, approved.newState, [], 2_000);
    const seal = materialized.newState.accounts.get(counterparty)?.mempool[0];
    expect(materialized.newState.deferredAccountProposals?.has(counterparty)).toBe(false);
    expect(materialized.collectedHashes?.map(({ type }) => type)).toEqual(['settlement', 'dispute']);
    expect(seal).toMatchObject({
      type: 'settle_transition',
      data: { kind: 'seal', settlementNonce: 6, postProof: { nonce: 7 } },
    });
  });

  test('materializes a deferred counter-seal beside an ordinary tx frozen by the peer-signed workspace', async () => {
    const env = createEmptyEnv('settlement-transition-frozen-counter-seal');
    const jurisdiction = makeJurisdiction('settlement-transition-frozen-counter-seal', 31337, 'a7', 'b8');
    const signerA = registerTestSigner(env, 'settlement-transition-frozen-counter-seal', '1');
    const signerB = registerTestSigner(env, 'settlement-transition-frozen-counter-seal', '2');
    const entityA = generateLazyEntityId([signerA], 1n).toLowerCase();
    const entityB = generateLazyEntityId([signerB], 1n).toLowerCase();
    const [leftEntity, rightEntity] = entityA < entityB ? [entityA, entityB] : [entityB, entityA];
    const leftSigner = leftEntity === entityA ? signerA : signerB;
    const rightSigner = rightEntity === entityA ? signerA : signerB;
    const leftState = makeState(leftEntity, leftSigner, jurisdiction, rightEntity);
    const rightState = makeState(rightEntity, rightSigner, jurisdiction, leftEntity);
    addReplica(env, leftState, leftSigner);
    addReplica(env, rightState, rightSigner);
    installProofStack(env, rightState);
    const leftAccount = leftState.accounts.get(rightEntity)!;
    const rightAccount = rightState.accounts.get(leftEntity)!;
    const upsertTx = transition({
      kind: 'upsert',
      version: 1,
      ops: [{ type: 'r2r', tokenId: 1, amount: 4n }],
      executorIsLeft: true,
    });
    expect((await applyAccountTx(leftAccount, upsertTx, true, 1_000)).success).toBe(true);
    expect((await applyAccountTx(rightAccount, upsertTx, true, 1_000)).success).toBe(true);

    const peerDraft = buildSettlementSealDraft(rightAccount, rightState, leftEntity, env);
    const peerSeal = await attachSettlementSealWitness(
      env,
      rightState,
      leftEntity,
      peerDraft.tx,
      peerDraft.hashesToSign,
      1,
    );
    expect((await applyAccountTx(leftAccount, peerSeal, false, 2_000, 0, false, env)).success).toBe(true);
    expect(leftAccount.settlementWorkspace?.rightHanko).toBeDefined();
    expect(leftAccount.settlementWorkspace?.postSettlementDisputeProof?.rightHanko).toBeDefined();

    await processCommittedSettlementTransitionFollowup(
      leftAccount,
      peerSeal,
      {
        ...leftAccount.currentFrame,
        height: 1,
        timestamp: 2_000,
        accountTxs: [peerSeal],
        byLeft: false,
      },
      rightEntity,
      leftState,
      env,
    );
    const workspaceHash = leftAccount.settlementWorkspace!.workspaceHash;
    expect(leftState.deferredAccountProposals?.get(rightEntity)).toBe(workspaceHash);
    leftAccount.mempool.push({ type: 'direct_payment', data: { tokenId: 1, amount: 1n } });

    const materialized = await applyEntityFrame(env, leftState, [], 3_000);
    const materializedAccount = materialized.newState.accounts.get(rightEntity)!;

    expect(materialized.newState.deferredAccountProposals?.has(rightEntity)).toBe(false);
    expect(materialized.collectedHashes?.map(({ type }) => type)).toEqual(['dispute']);
    expect(materializedAccount.mempool.map(tx => tx.type)).toEqual([
      'direct_payment',
      'settle_transition',
    ]);
    expect(materializedAccount.mempool[1]).toMatchObject({
      type: 'settle_transition',
      data: {
        kind: 'seal',
        workspaceHash,
        settlementNonce: 1,
        postProof: { nonce: 2 },
      },
    });
  });

  test('receiver rejects a one-slot settlement nonce tolerance before any Hanko mutation', async () => {
    const account = makeAccount(LEFT, RIGHT);
    expect((await upsert(account, {
      version: 1,
      ops: [{ type: 'r2r', tokenId: 1, amount: 4n }],
      executorIsLeft: false,
    })).success).toBe(true);
    account.proofHeader.nextProofNonce = 5;
    const workspaceHash = account.settlementWorkspace!.workspaceHash;
    const result = await applyAccountTx(account, transition({
      kind: 'seal',
      version: 1,
      workspaceHash,
      settlementNonce: 6,
      settlementHash: `0x${'91'.repeat(32)}`,
      postProof: {
        nonce: 7,
        proofBodyHash: `0x${'92'.repeat(32)}`,
        disputeHash: `0x${'93'.repeat(32)}`,
        hanko: '0x1234',
      },
      settlementHanko: '0x5678',
    }), true, 2_000, 0, false, createEmptyEnv('settlement-exact-nonce-reject'));

    expect(result.success).toBe(false);
    expect(result.error).toContain('SETTLEMENT_SEAL_NONCE_MISMATCH:6:5');
    expect(account.settlementWorkspace?.nonceAtSign).toBeUndefined();
    expect(account.settlementWorkspace?.leftHanko).toBeUndefined();
    expect(account.settlementWorkspace?.postSettlementDisputeProof).toBeUndefined();
  });

  test('workspace hash binds parties, version, ops, modifier side, executor, and memo only', () => {
    const leftView = makeAccount(LEFT, RIGHT);
    const rightView = makeAccount(RIGHT, LEFT);
    const body = {
      version: 1,
      ops: [{ type: 'r2r' as const, tokenId: 1, amount: 4n }],
      lastModifiedByLeft: true,
      executorIsLeft: false,
      memo: 'canonical',
    };
    const hash = createSettlementWorkspaceHash(leftView, body);
    expect(createSettlementWorkspaceHash(rightView, body)).toBe(hash);
    expect(createSettlementWorkspaceHash(leftView, { ...body, version: 2 })).not.toBe(hash);
    expect(createSettlementWorkspaceHash(leftView, { ...body, executorIsLeft: true })).not.toBe(hash);
    expect(createSettlementWorkspaceHash(leftView, { ...body, memo: 'different' })).not.toBe(hash);
    expect(createSettlementWorkspaceHash(leftView, {
      ...body,
      ops: [{ type: 'r2r', tokenId: 1, amount: 5n }],
    })).not.toBe(hash);
    expect(createSettlementWorkspaceHash(makeAccount(entity('01'), RIGHT), body)).not.toBe(hash);
  });

  test('Entity proposal only queues the bilateral transition and does not pre-mutate workspace', async () => {
    const env = createEmptyEnv('settlement-transition-entity-proposal');
    const jurisdiction = makeJurisdiction('settlement-transition', 31337, 'a1', 'b2');
    const leftSigner = addr('31');
    const rightSigner = addr('32');
    const leftState = makeState(LEFT, leftSigner, jurisdiction, RIGHT);
    const rightState = makeState(RIGHT, rightSigner, jurisdiction, LEFT);
    addReplica(env, leftState, leftSigner);
    addReplica(env, rightState, rightSigner);

    const result = await handleSettlePropose(leftState, {
      type: 'settle_propose',
      data: {
        counterpartyEntityId: RIGHT,
        ops: [{ type: 'r2r', tokenId: 1, amount: 4n }],
        executorIsLeft: false,
      },
    }, env);

    expect(result.newState.accounts.get(RIGHT)?.settlementWorkspace).toBeUndefined();
    expect(result.outputs).toEqual([]);
    expect(result.mempoolOps).toHaveLength(1);
    expect(result.mempoolOps[0]?.tx).toMatchObject({
      type: 'settle_transition',
      data: { kind: 'upsert', version: 1, executorIsLeft: false },
    });
  });

  test('an Account frame creates the workspace and its holds without Entity-local prestate', async () => {
    const account = makeAccount(LEFT, RIGHT);

    const result = await upsert(account, {
      version: 1,
      ops: [{ type: 'r2r', tokenId: 1, amount: 4n }],
      executorIsLeft: false,
      memo: 'frame-only proposal',
    });

    expect(result.success).toBe(true);
    expect(account.settlementWorkspace).toMatchObject({
      version: 1,
      lastModifiedByLeft: true,
      executorIsLeft: false,
      memo: 'frame-only proposal',
      status: 'awaiting_counterparty',
    });
    expect(account.settlementWorkspace?.workspaceHash).toMatch(/^0x[0-9a-f]{64}$/);
    expect(account.deltas.get(1)?.leftHold).toBe(4n);
  });

  test('safe counterparty auto-approval starts only after the upsert Account frame commits', async () => {
    const env = createEmptyEnv('settlement-transition-committed-auto-approve');
    const jurisdiction = makeJurisdiction('settlement-transition', 31337, 'a1', 'b2');
    const leftSigner = registerTestSigner(env, 'settlement-transition-committed-auto-approve', '1');
    const rightSigner = registerTestSigner(env, 'settlement-transition-committed-auto-approve', '2');
    const leftState = makeState(LEFT, leftSigner, jurisdiction, RIGHT);
    const rightState = makeState(RIGHT, rightSigner, jurisdiction, LEFT);
    const rightSecondSigner = addr('33');
    rightState.config.validators = [rightSigner, rightSecondSigner];
    rightState.config.shares = { [rightSigner]: 1n, [rightSecondSigner]: 1n };
    rightState.config.threshold = 2n;
    addReplica(env, leftState, leftSigner);
    addReplica(env, rightState, rightSigner);
    const rightAccount = rightState.accounts.get(LEFT)!;
    const tx = transition({
      kind: 'upsert',
      version: 1,
      ops: [{ type: 'r2r', tokenId: 1, amount: 4n }],
      executorIsLeft: true,
    });

    expect(rightAccount.settlementWorkspace).toBeUndefined();
    const applied = await applyAccountTx(rightAccount, tx, true, 1_000);
    expect(applied.success).toBe(true);
    expect(rightAccount.settlementWorkspace?.rightHanko).toBeUndefined();

    const followup = await processCommittedSettlementTransitionFollowup(
      rightAccount,
      tx,
      {
        ...rightAccount.currentFrame,
        height: 1,
        timestamp: 1_000,
        accountTxs: [tx],
        byLeft: true,
      },
      LEFT,
      rightState,
      env,
    );

    // Auto-approval records exact intent. Consensus materializes its nonce and
    // secondary hashes only after every earlier Account transition drains.
    expect(rightAccount.settlementWorkspace?.rightHanko).toBeUndefined();
    expect(followup.outputs).toEqual([]);
    expect(followup.mempoolOps).toEqual([]);
    expect(followup.hashesToSign).toEqual([]);
    expect(rightState.deferredAccountProposals?.get(LEFT))
      .toBe(rightAccount.settlementWorkspace?.workspaceHash);
  });

  test('pure debt forgiveness is never classified as safe for automatic approval', async () => {
    const pureForgiveness = makeAccount(LEFT, RIGHT);
    expect((await upsert(pureForgiveness, {
      version: 1,
      ops: [{ type: 'forgive', tokenId: 1 }],
      executorIsLeft: true,
    })).success).toBe(true);
    expect(canAutoApproveWorkspace(pureForgiveness.settlementWorkspace!, false)).toBe(false);
  });

  test('pure forgiveness pre-signs a post-settlement proof containing the newly observed token slot', async () => {
    const jurisdiction = makeJurisdiction('settlement-forgiveness-proof', 31337, 'a8', 'b9');
    const state = makeState(LEFT, addr('38'), jurisdiction, RIGHT);
    const account = state.accounts.get(RIGHT)!;
    const tokenId = 9;
    expect(account.deltas.has(tokenId)).toBe(false);
    expect((await upsert(account, {
      version: 1,
      ops: [{ type: 'forgive', tokenId }],
      executorIsLeft: true,
    })).success).toBe(true);

    const env = createEmptyEnv('settlement-forgiveness-proof');
    installProofStack(env, state);
    const draft = buildSettlementSealDraft(account, state, RIGHT, env).tx;
    if (draft.type !== 'settle_transition' || draft.data.kind !== 'seal') {
      throw new Error('TEST_FORGIVENESS_SETTLEMENT_SEAL_MISSING');
    }
    const expected = cloneAccountMachine(account);
    expected.deltas.set(tokenId, createDefaultDelta(tokenId));
    expect(draft.data.postProof.proofBodyHash)
      .toBe(buildAccountProofBody(expected, TEST_DELTA_TRANSFORMER).proofBodyHash);
    expect(draft.data.postProof.proofBodyHash)
      .not.toBe(buildAccountProofBody(account, TEST_DELTA_TRANSFORMER).proofBodyHash);
  });

  test('pure-forgiveness AccountSettled finality activates the exact projected recovery proof', async () => {
    const jurisdiction = makeJurisdiction('settlement-forgiveness-finality', 31337, 'aa', 'bb');
    const state = makeState(LEFT, addr('39'), jurisdiction, RIGHT);
    const account = state.accounts.get(RIGHT)!;
    const tokenId = 9;
    expect((await upsert(account, {
      version: 1,
      ops: [{ type: 'forgive', tokenId }],
      executorIsLeft: true,
    })).success).toBe(true);
    const env = createEmptyEnv('settlement-forgiveness-finality');
    installProofStack(env, state);
    const draft = buildSettlementSealDraft(account, state, RIGHT, env).tx;
    if (draft.type !== 'settle_transition' || draft.data.kind !== 'seal') {
      throw new Error('TEST_FORGIVENESS_SETTLEMENT_SEAL_MISSING');
    }
    const workspace = account.settlementWorkspace!;
    workspace.nonceAtSign = draft.data.settlementNonce;
    workspace.settlementHash = draft.data.settlementHash;
    workspace.leftHanko = '0x1234';
    workspace.rightHanko = '0x5678';
    workspace.postSettlementDisputeProof = {
      ...draft.data.postProof,
      leftHanko: '0x9abc',
      rightHanko: '0xdef0',
    };
    const event = accountSettledEvent(draft.data.settlementNonce);
    event.data.tokenId = tokenId;

    applyFinalizedAccountJEvents(account, RIGHT, [event], TEST_DELTA_TRANSFORMER);

    expect(account.deltas.has(tokenId)).toBe(true);
    expect(account.currentDisputeProofBodyHash).toBe(draft.data.postProof.proofBodyHash);
    expect(account.counterpartyDisputeProofBodyHash).toBe(draft.data.postProof.proofBodyHash);
    expect(account.currentDisputeProofNonce).toBe(draft.data.postProof.nonce);
    expect(account.settlementWorkspace).toBeUndefined();
  });

  test('a mixed workspace containing debt forgiveness always requires explicit approval', async () => {
    const mixedForgiveness = makeAccount(LEFT, RIGHT);
    expect((await upsert(mixedForgiveness, {
      version: 1,
      ops: [
        { type: 'r2r', tokenId: 1, amount: 4n },
        { type: 'forgive', tokenId: 1 },
      ],
      executorIsLeft: true,
    })).success).toBe(true);
    expect(canAutoApproveWorkspace(mixedForgiveness.settlementWorkspace!, false)).toBe(false);
  });

  test('non-executor settlement execution fails before creating any J batch state', async () => {
    const env = createEmptyEnv('settlement-transition-non-executor');
    const jurisdiction = makeJurisdiction('settlement-transition', 31337, 'a1', 'b2');
    const leftSigner = registerTestSigner(env, 'settlement-transition-non-executor', '1');
    const leftState = makeState(LEFT, leftSigner, jurisdiction, RIGHT);
    addReplica(env, leftState, leftSigner);
    const account = leftState.accounts.get(RIGHT)!;
    expect((await upsert(account, {
      version: 1,
      ops: [{ type: 'r2r', tokenId: 1, amount: 4n }],
      executorIsLeft: false,
    })).success).toBe(true);
    account.settlementWorkspace!.rightHanko = '0x1234';
    account.settlementWorkspace!.nonceAtSign = 1;
    account.settlementWorkspace!.settlementHash = `0x${'91'.repeat(32)}`;

    await expect(handleSettleExecute(leftState, {
      type: 'settle_execute',
      data: { counterpartyEntityId: RIGHT, disableC2RShortcut: true },
    }, env)).rejects.toThrow('SETTLEMENT_EXECUTOR_MISMATCH');

    expect(leftState.jBatchState).toBeUndefined();
    expect(account.mempool).toHaveLength(0);
  });

  test('elected executor rejects a signed workspace missing its exact nonce before J batch mutation', async () => {
    const env = createEmptyEnv('settlement-transition-missing-signed-nonce');
    const jurisdiction = makeJurisdiction('settlement-transition', 31337, 'a1', 'b2');
    const leftSigner = registerTestSigner(env, 'settlement-transition-missing-signed-nonce', '1');
    const leftState = makeState(LEFT, leftSigner, jurisdiction, RIGHT);
    addReplica(env, leftState, leftSigner);
    const account = leftState.accounts.get(RIGHT)!;
    expect((await upsert(account, {
      version: 1,
      ops: [{ type: 'r2r', tokenId: 1, amount: 4n }],
      executorIsLeft: true,
    })).success).toBe(true);
    account.settlementWorkspace!.rightHanko = '0x1234';
    account.settlementWorkspace!.settlementHash = `0x${'92'.repeat(32)}`;

    await expect(handleSettleExecute(leftState, {
      type: 'settle_execute',
      data: { counterpartyEntityId: RIGHT, disableC2RShortcut: true },
    }, env)).rejects.toThrow('SETTLEMENT_SIGNED_NONCE_MISSING');

    expect(leftState.jBatchState).toBeUndefined();
    expect(account.mempool).toHaveLength(0);
  });

  test('elected executor rejects a signed workspace missing its exact hash before J batch mutation', async () => {
    const env = createEmptyEnv('settlement-transition-missing-signed-hash');
    const jurisdiction = makeJurisdiction('settlement-transition', 31337, 'a1', 'b2');
    const leftSigner = registerTestSigner(env, 'settlement-transition-missing-signed-hash', '1');
    const leftState = makeState(LEFT, leftSigner, jurisdiction, RIGHT);
    addReplica(env, leftState, leftSigner);
    const account = leftState.accounts.get(RIGHT)!;
    expect((await upsert(account, {
      version: 1,
      ops: [{ type: 'r2r', tokenId: 1, amount: 4n }],
      executorIsLeft: true,
    })).success).toBe(true);
    account.settlementWorkspace!.rightHanko = '0x1234';
    account.settlementWorkspace!.nonceAtSign = 1;

    await expect(handleSettleExecute(leftState, {
      type: 'settle_execute',
      data: { counterpartyEntityId: RIGHT, disableC2RShortcut: true },
    }, env)).rejects.toThrow('SETTLEMENT_SIGNED_HASH_MISSING');

    expect(leftState.jBatchState).toBeUndefined();
    expect(account.mempool).toHaveLength(0);
  });

  test('bilateral Account seals carry role-aware settlement and post-proof Hankos', async () => {
    const rightEnv = createEmptyEnv('settlement-transition-post-proof-wire');
    const jurisdiction = makeJurisdiction('settlement-transition', 31337, 'a1', 'b2');
    const signerA = registerTestSigner(rightEnv, 'settlement-transition-post-proof-wire', '1');
    const signerB = registerTestSigner(rightEnv, 'settlement-transition-post-proof-wire', '2');
    const entityA = generateLazyEntityId([signerA], 1n).toLowerCase();
    const entityB = generateLazyEntityId([signerB], 1n).toLowerCase();
    const [leftEntity, rightEntity] = entityA < entityB ? [entityA, entityB] : [entityB, entityA];
    const leftSigner = leftEntity === entityA ? signerA : signerB;
    const rightSigner = rightEntity === entityA ? signerA : signerB;
    const rightState = makeState(rightEntity, rightSigner, jurisdiction, leftEntity);
    const leftState = makeState(leftEntity, leftSigner, jurisdiction, rightEntity);
    addReplica(rightEnv, rightState, rightSigner);
    addReplica(rightEnv, leftState, leftSigner);
    installProofStack(rightEnv, rightState);
    const rightAccount = rightState.accounts.get(leftEntity)!;
    const leftAccount = leftState.accounts.get(rightEntity)!;
    const tx = transition({
      kind: 'upsert',
      version: 1,
      ops: [{ type: 'r2r', tokenId: 1, amount: 4n }],
      executorIsLeft: true,
    });
    expect((await applyAccountTx(rightAccount, tx, true, 1_000)).success).toBe(true);
    expect((await applyAccountTx(leftAccount, tx, true, 1_000)).success).toBe(true);

    const rightApproval = await handleSettleApprove(
      rightState,
      {
        type: 'settle_approve',
        data: { counterpartyEntityId: leftEntity, workspaceHash: rightAccount.settlementWorkspace!.workspaceHash },
      },
      rightEnv,
    );
    expect(rightApproval.outputs).toEqual([]);
    expect(rightApproval.newState.deferredAccountProposals?.get(leftEntity))
      .toBe(rightAccount.settlementWorkspace!.workspaceHash);
    const rightSealDraft = buildSettlementSealDraft(
      rightApproval.newState.accounts.get(leftEntity)!,
      rightApproval.newState,
      leftEntity,
      rightEnv,
    );
    expect(rightSealDraft.hashesToSign.map(({ type }) => type)).toEqual(['settlement', 'dispute']);
    const rightDraft = rightSealDraft.tx;
    if (rightDraft?.type !== 'settle_transition' || rightDraft.data.kind !== 'seal') {
      throw new Error('TEST_RIGHT_SETTLEMENT_SEAL_MISSING');
    }
    expect(rightDraft.data).toMatchObject({
      settlementNonce: 1,
      postProof: { nonce: 2 },
    });
    expect(rightDraft.data.settlementHanko).toBeUndefined();
    expect(rightDraft.data.postProof.hanko).toBeUndefined();
    const rightSealingState = rightApproval.newState;
    const sealedRightTx = await attachSettlementSealWitness(
      rightEnv,
      rightSealingState,
      leftEntity,
      rightDraft,
      rightSealDraft.hashesToSign,
      1,
    );
    if (sealedRightTx.data.kind !== 'seal') throw new Error('TEST_RIGHT_SETTLEMENT_SEAL_INVALID');
    expect(sealedRightTx.data.settlementHanko).toBeDefined();
    expect(sealedRightTx.data.postProof.hanko).toBeDefined();
    expect((await applyAccountTx(
      rightSealingState.accounts.get(leftEntity)!, sealedRightTx, false, 2_000, 0, false, rightEnv,
    )).success).toBe(true);
    expect((await applyAccountTx(leftAccount, sealedRightTx, false, 2_000, 0, false, rightEnv)).success).toBe(true);

    const leftApproval = await handleSettleApprove(
      leftState,
      {
        type: 'settle_approve',
        data: { counterpartyEntityId: rightEntity, workspaceHash: leftAccount.settlementWorkspace!.workspaceHash },
      },
      rightEnv,
    );
    const leftSealDraft = buildSettlementSealDraft(
      leftApproval.newState.accounts.get(rightEntity)!,
      leftApproval.newState,
      rightEntity,
      rightEnv,
    );
    expect(leftSealDraft.hashesToSign.map(({ type }) => type)).toEqual(['dispute']);
    const leftDraft = leftSealDraft.tx;
    if (leftDraft?.type !== 'settle_transition' || leftDraft.data.kind !== 'seal') {
      throw new Error('TEST_LEFT_SETTLEMENT_SEAL_MISSING');
    }
    const leftSealingState = leftApproval.newState;
    const sealedLeftTx = await attachSettlementSealWitness(
      rightEnv,
      leftSealingState,
      rightEntity,
      leftDraft,
      leftSealDraft.hashesToSign,
      2,
    );
    if (sealedLeftTx.data.kind !== 'seal') throw new Error('TEST_LEFT_SETTLEMENT_SEAL_INVALID');
    expect(sealedLeftTx.data.settlementHanko).toBeUndefined();
    expect(sealedLeftTx.data.postProof.hanko).toBeDefined();
    expect((await applyAccountTx(
      leftSealingState.accounts.get(rightEntity)!, sealedLeftTx, true, 3_000, 0, false, rightEnv,
    )).success).toBe(true);
    expect((await applyAccountTx(
      rightSealingState.accounts.get(leftEntity)!, sealedLeftTx, true, 3_000, 0, false, rightEnv,
    )).success).toBe(true);

    const finalizedLeftWorkspace = leftSealingState.accounts.get(rightEntity)!.settlementWorkspace!;
    const finalizedRightWorkspace = rightSealingState.accounts.get(leftEntity)!.settlementWorkspace!;
    expect(finalizedLeftWorkspace.status).toBe('ready_to_submit');
    expect(finalizedRightWorkspace.status).toBe('ready_to_submit');
    expect(finalizedLeftWorkspace.leftHanko).toBeUndefined();
    expect(finalizedLeftWorkspace.rightHanko).toBeDefined();
    expect(finalizedLeftWorkspace.postSettlementDisputeProof?.leftHanko).toBeDefined();
    expect(finalizedLeftWorkspace.postSettlementDisputeProof?.rightHanko).toBeDefined();
    expect(finalizedRightWorkspace).toEqual(finalizedLeftWorkspace);
  });

  test('a registered local proposer verifies its seal against certified board authority', async () => {
    const env = createEmptyEnv('settlement-transition-registered-seal');
    const jurisdiction = makeJurisdiction('settlement-transition-registered', 31337, 'a3', 'b4');
    const leftSigner = registerTestSigner(env, 'settlement-transition-registered-seal', '1');
    const rightSigner = registerTestSigner(env, 'settlement-transition-registered-seal', '2');
    const leftEntity = generateNumberedEntityId(2).toLowerCase();
    const rightEntity = generateLazyEntityId([rightSigner], 1n).toLowerCase();
    const leftState = makeState(leftEntity, leftSigner, jurisdiction, rightEntity);
    const rightState = makeState(rightEntity, rightSigner, jurisdiction, leftEntity);
    addReplica(env, leftState, leftSigner);
    addReplica(env, rightState, rightSigner);
    installProofStack(env, leftState);
    const registeredBoardHash = generateLazyEntityId([leftSigner], 1n).toLowerCase();
    installRegisteredBoard(
      env,
      leftState,
      jurisdiction,
      registeredBoardHash,
    );

    const upsertTx = transition({
      kind: 'upsert',
      version: 1,
      ops: [{ type: 'r2r', tokenId: 1, amount: 4n }],
      executorIsLeft: false,
    });
    expect((await applyAccountTx(leftState.accounts.get(rightEntity)!, upsertTx, false, 1_000)).success).toBe(true);
    expect((await applyAccountTx(rightState.accounts.get(leftEntity)!, upsertTx, false, 1_000)).success).toBe(true);

    const approval = await handleSettleApprove(
      leftState,
      {
        type: 'settle_approve',
        data: {
          counterpartyEntityId: rightEntity,
          workspaceHash: leftState.accounts.get(rightEntity)!.settlementWorkspace!.workspaceHash,
        },
      },
      env,
    );
    const sealDraft = buildSettlementSealDraft(
      approval.newState.accounts.get(rightEntity)!,
      approval.newState,
      rightEntity,
      env,
    );
    const draft = sealDraft.tx;
    if (draft?.type !== 'settle_transition' || draft.data.kind !== 'seal') {
      throw new Error('TEST_REGISTERED_SETTLEMENT_SEAL_MISSING');
    }
    const sealingState = approval.newState;
    const sealedTx = await attachSettlementSealWitness(
      env,
      sealingState,
      rightEntity,
      draft,
      sealDraft.hashesToSign,
      1,
    );
    const result = await applyAccountTx(
      sealingState.accounts.get(rightEntity)!,
      sealedTx,
      true,
      2_000,
      0,
      false,
      env,
    );
    expect(result).toMatchObject({ success: true });
    expect(sealingState.accounts.get(rightEntity)!.settlementWorkspace?.leftHanko).toBeDefined();
    const receiverResult = await applyAccountTx(
      rightState.accounts.get(leftEntity)!,
      sealedTx,
      true,
      2_000,
      0,
      true,
      env,
      undefined,
      registeredBoardHash,
    );
    expect(receiverResult).toMatchObject({ success: true });
  });

  test('only the final settlement transition in a committed Account frame can trigger approval', async () => {
    const env = createEmptyEnv('settlement-transition-final-frame-state');
    const jurisdiction = makeJurisdiction('settlement-transition', 31337, 'a1', 'b2');
    const leftSigner = registerTestSigner(env, 'settlement-transition-final-frame-state', '1');
    const rightSigner = registerTestSigner(env, 'settlement-transition-final-frame-state', '2');
    const leftState = makeState(LEFT, leftSigner, jurisdiction, RIGHT);
    const rightState = makeState(RIGHT, rightSigner, jurisdiction, LEFT);
    const rightSecondSigner = addr('34');
    rightState.config.validators = [rightSigner, rightSecondSigner];
    rightState.config.shares = { [rightSigner]: 1n, [rightSecondSigner]: 1n };
    rightState.config.threshold = 2n;
    addReplica(env, leftState, leftSigner);
    addReplica(env, rightState, rightSigner);
    const account = rightState.accounts.get(LEFT)!;
    const first = transition({
      kind: 'upsert',
      version: 1,
      ops: [{ type: 'r2r', tokenId: 1, amount: 4n }],
      executorIsLeft: false,
    });
    expect((await applyAccountTx(account, first, true, 1_000)).success).toBe(true);
    const second = transition({
      kind: 'upsert',
      version: 2,
      previousWorkspaceHash: account.settlementWorkspace!.workspaceHash,
      ops: [{ type: 'r2r', tokenId: 1, amount: 2n }],
      executorIsLeft: false,
    });
    expect((await applyAccountTx(account, second, true, 1_001)).success).toBe(true);
    const frame = {
      ...account.currentFrame,
      height: 1,
      timestamp: 1_001,
      accountTxs: [first, second],
      byLeft: true,
    };

    const staleFollowup = await processCommittedSettlementTransitionFollowup(
      account,
      first,
      frame,
      LEFT,
      rightState,
      env,
    );
    const finalFollowup = await processCommittedSettlementTransitionFollowup(
      account,
      second,
      frame,
      LEFT,
      rightState,
      env,
    );

    expect(staleFollowup).toEqual({ outputs: [], mempoolOps: [], hashesToSign: [] });
    expect(finalFollowup.outputs).toEqual([]);
    expect(finalFollowup.mempoolOps).toEqual([]);
    expect(finalFollowup.hashesToSign).toEqual([]);
    expect(rightState.deferredAccountProposals?.get(LEFT))
      .toBe(account.settlementWorkspace?.workspaceHash);
  });

  test('a multi-token update validates on a clone and commits old-release/new-add atomically', async () => {
    const account = makeAccount(LEFT, RIGHT);
    const token2 = createDefaultDelta(2);
    token2.leftCreditLimit = 100n;
    token2.rightCreditLimit = 100n;
    const unrelated = createDefaultDelta(3);
    unrelated.leftHold = 9n;
    unrelated.rightHold = 8n;
    account.deltas.set(2, token2);
    account.deltas.set(3, unrelated);

    const first = await upsert(account, {
      version: 1,
      ops: [
        { type: 'r2r', tokenId: 1, amount: 3n },
        {
          type: 'rawDiff',
          tokenId: 2,
          leftDiff: 2n,
          rightDiff: -2n,
          collateralDiff: 0n,
          ondeltaDiff: 0n,
        },
      ],
      executorIsLeft: false,
    });
    expect(first.success).toBe(true);
    const firstHash = account.settlementWorkspace?.workspaceHash;
    expect(firstHash).toMatch(/^0x[0-9a-f]{64}$/);
    expect(account.deltas.get(1)?.leftHold).toBe(3n);
    expect(account.deltas.get(2)?.rightHold).toBe(2n);

    const invalid = await upsert(account, {
      version: 2,
      previousWorkspaceHash: firstHash,
      ops: [
        { type: 'r2r', tokenId: 1, amount: 1n },
        {
          type: 'rawDiff',
          tokenId: 2,
          leftDiff: 10n ** 31n,
          rightDiff: -(10n ** 31n),
          collateralDiff: 0n,
          ondeltaDiff: 0n,
        },
      ],
      executorIsLeft: true,
    });

    expect(invalid.success).toBe(false);
    expect(account.settlementWorkspace?.workspaceHash).toBe(firstHash);
    expect(account.settlementWorkspace?.version).toBe(1);
    expect(account.deltas.get(1)?.leftHold).toBe(3n);
    expect(account.deltas.get(2)?.rightHold).toBe(2n);
    expect(account.deltas.get(3)?.leftHold).toBe(9n);
    expect(account.deltas.get(3)?.rightHold).toBe(8n);

    const valid = await upsert(account, {
      version: 2,
      previousWorkspaceHash: firstHash,
      ops: [
        { type: 'r2r', tokenId: 1, amount: 1n },
        {
          type: 'rawDiff',
          tokenId: 2,
          leftDiff: 4n,
          rightDiff: -4n,
          collateralDiff: 0n,
          ondeltaDiff: 0n,
        },
      ],
      executorIsLeft: true,
    });

    expect(valid.success).toBe(true);
    expect(account.settlementWorkspace?.version).toBe(2);
    expect(account.settlementWorkspace?.workspaceHash).not.toBe(firstHash);
    expect(account.settlementWorkspace?.lastModifiedByLeft).toBe(true);
    expect(account.deltas.get(1)?.leftHold).toBe(1n);
    expect(account.deltas.get(2)?.rightHold).toBe(4n);
    expect(account.deltas.get(3)?.leftHold).toBe(9n);
    expect(account.deltas.get(3)?.rightHold).toBe(8n);
  });

  test('submit requires the elected executor and exact workspace hash, then releases only workspace holds', async () => {
    const account = makeAccount(LEFT, RIGHT);
    account.deltas.get(1)!.rightHold = 7n;
    const first = await upsert(account, {
      version: 1,
      ops: [{ type: 'r2r', tokenId: 1, amount: 4n }],
      executorIsLeft: false,
    });
    expect(first.success).toBe(true);
    const workspaceHash = account.settlementWorkspace!.workspaceHash;
    account.settlementWorkspace!.leftHanko = '0x1234';
    account.settlementWorkspace!.nonceAtSign = 1;
    account.settlementWorkspace!.settlementHash = `0x${'41'.repeat(32)}`;
    account.settlementWorkspace!.postSettlementDisputeProof = {
      leftHanko: '0x5678',
      rightHanko: '0x9abc',
      disputeHash: `0x${'42'.repeat(32)}`,
      proofBodyHash: `0x${'43'.repeat(32)}`,
      nonce: 2,
    };
    account.settlementWorkspace!.status = 'ready_to_submit';

    const wrongSide = await applyAccountTx(account, transition({
      kind: 'submit',
      version: 1,
      workspaceHash,
    }), true, 2_000);
    expect(wrongSide.success).toBe(false);
    expect(account.settlementWorkspace?.status).toBe('ready_to_submit');
    expect(account.deltas.get(1)?.leftHold).toBe(4n);
    expect(account.deltas.get(1)?.rightHold).toBe(7n);

    const submitted = await applyAccountTx(account, transition({
      kind: 'submit',
      version: 1,
      workspaceHash,
    }), false, 2_001);
    expect(submitted.success).toBe(true);
    expect(account.settlementWorkspace?.status).toBe('submitted');
    expect(account.deltas.get(1)?.leftHold).toBe(0n);
    expect(account.deltas.get(1)?.rightHold).toBe(7n);
  });

  test('clear derives releases from the exact active workspace and removes it atomically', async () => {
    const account = makeAccount(LEFT, RIGHT);
    const first = await upsert(account, {
      version: 1,
      ops: [{ type: 'r2r', tokenId: 1, amount: 4n }],
      executorIsLeft: false,
    });
    expect(first.success).toBe(true);
    const workspaceHash = account.settlementWorkspace!.workspaceHash;

    const mismatched = await applyAccountTx(account, transition({
      kind: 'clear',
      version: 1,
      workspaceHash: `0x${'ff'.repeat(32)}`,
    }), false, 2_000);
    expect(mismatched.success).toBe(false);
    expect(account.settlementWorkspace?.workspaceHash).toBe(workspaceHash);
    expect(account.deltas.get(1)?.leftHold).toBe(4n);

    const cleared = await applyAccountTx(account, transition({
      kind: 'clear',
      version: 1,
      workspaceHash,
    }), false, 2_001);
    expect(cleared.success).toBe(true);
    expect(account.settlementWorkspace).toBeUndefined();
    expect(account.deltas.get(1)?.leftHold).toBe(0n);
  });

  test('a signed settlement freezes financial Account txs but never blocks dispute reopen', async () => {
    const account = await signedWorkspaceAccount(10);
    const beforeOffdelta = account.deltas.get(1)?.offdelta;

    const payment = await applyAccountTx(account, {
      type: 'direct_payment',
      data: { tokenId: 1, amount: 1n },
    }, true, 2_000);
    expect(payment.success).toBe(false);
    expect(payment.error).toBe('SETTLEMENT_SIGNED_ACCOUNT_FROZEN:direct_payment');
    expect(account.deltas.get(1)?.offdelta).toBe(beforeOffdelta);

    account.status = 'disputed';
    const reopen = await applyAccountTx(account, {
      type: 'reopen_disputed',
      data: { jNonce: 11 },
    }, true, 2_001);
    expect(reopen.success).toBe(true);
    expect(account.status).toBe('active');
    expect(account.jNonce).toBe(11);
  });

  test('AccountSettled finality wins a submit retry race by releasing exact workspace holds', async () => {
    const account = makeAccount(LEFT, RIGHT);
    account.deltas.get(1)!.rightHold = 6n;
    const first = await upsert(account, {
      version: 1,
      ops: [{ type: 'r2r', tokenId: 1, amount: 4n }],
      executorIsLeft: false,
    });
    expect(first.success).toBe(true);
    account.settlementWorkspace!.leftHanko = '0x1234';
    account.settlementWorkspace!.nonceAtSign = 1;
    account.settlementWorkspace!.settlementHash = `0x${'51'.repeat(32)}`;
    account.settlementWorkspace!.postSettlementDisputeProof = {
      leftHanko: '0x5678',
      rightHanko: '0x9abc',
      disputeHash: `0x${'52'.repeat(32)}`,
      proofBodyHash: buildAccountProofBody(account, TEST_DELTA_TRANSFORMER).proofBodyHash,
      nonce: 2,
    };

    applyFinalizedAccountJEvents(account, RIGHT, [{
      type: 'AccountSettled',
      data: {
        leftEntity: LEFT,
        rightEntity: RIGHT,
        tokenId: 1,
        leftReserve: '0',
        rightReserve: '0',
        collateral: '0',
        ondelta: '0',
        nonce: 1,
      },
    }], TEST_DELTA_TRANSFORMER);

    expect(account.settlementWorkspace).toBeUndefined();
    expect(account.deltas.get(1)?.leftHold).toBe(0n);
    expect(account.deltas.get(1)?.rightHold).toBe(6n);
    expect(account.jNonce).toBe(1);
  });

  test('bilaterally finalized AccountSettled claim deletes the submitted optional workspace', async () => {
    const env = createEmptyEnv('settlement-transition-finalized-claim-delete');
    const jurisdiction = makeJurisdiction('settlement-transition', 31337, 'a1', 'b2');
    const signer = addr('37');
    const state = makeState(LEFT, signer, jurisdiction, RIGHT);
    addReplica(env, state, signer);
    installProofStack(env, state);
    const account = state.accounts.get(RIGHT)!;
    expect((await upsert(account, {
      version: 1,
      ops: [{ type: 'r2r', tokenId: 1, amount: 4n }],
      executorIsLeft: false,
    })).success).toBe(true);
    account.settlementWorkspace!.leftHanko = '0x1234';
    account.settlementWorkspace!.status = 'submitted';
    account.settlementWorkspace!.nonceAtSign = 1;
    account.settlementWorkspace!.settlementHash = `0x${'70'.repeat(32)}`;
    account.settlementWorkspace!.postSettlementDisputeProof = {
      leftHanko: '0x5678',
      rightHanko: '0x9abc',
      disputeHash: `0x${'72'.repeat(32)}`,
      proofBodyHash: buildAccountProofBody(account, TEST_DELTA_TRANSFORMER).proofBodyHash,
      nonce: 2,
    };
    const rawClaim = {
      type: 'j_event_claim' as const,
      data: {
        jHeight: 7,
        jBlockHash: `0x${'71'.repeat(32)}`,
        events: [{
          type: 'AccountSettled' as const,
          data: {
            leftEntity: LEFT,
            rightEntity: RIGHT,
            tokenId: 1,
            leftReserve: '0',
            rightReserve: '0',
            collateral: '0',
            ondelta: '0',
            nonce: 1,
          },
        }],
      },
    };
    const domain = {
      chainId: Number(jurisdiction.chainId),
      depositoryAddress: jurisdiction.depositoryAddress,
    };
    const firstSession = createAccountJClaimSession(env);
    const leftClaim = prepareAccountJClaimTx(account, rawClaim, domain, firstSession);
    expect(handleJEventClaim(
      account, leftClaim, true, 2_000, false, LEFT, () => {}, env, firstSession,
    ).success).toBe(true);
    cacheCommittedAccountJClaimNodeChanges(env, firstSession.changes());
    const secondSession = createAccountJClaimSession(env);
    const rightClaim = prepareAccountJClaimTx(account, rawClaim, domain, secondSession);
    expect(handleJEventClaim(
      account, rightClaim, false, 2_001, false, LEFT, () => {}, env, secondSession,
    ).success).toBe(true);

    expect(account.lastFinalizedJHeight).toBe(7);
    expect(account.leftPendingJClaims.count).toBe(0n);
    expect(account.rightPendingJClaims.count).toBe(0n);
    expect(account.settlementWorkspace).toBeUndefined();
  });

  test('older AccountSettled nonce retains a newer signed workspace and does not activate its proof', async () => {
    const account = await signedWorkspaceAccount(10);
    const workspaceHash = account.settlementWorkspace!.workspaceHash;

    applyFinalizedAccountJEvents(account, RIGHT, [accountSettledEvent(9)], TEST_DELTA_TRANSFORMER);

    expect(account.jNonce).toBe(9);
    expect(account.settlementWorkspace?.workspaceHash).toBe(workspaceHash);
    expect(account.currentDisputeHash).toBeUndefined();
    expect(account.currentDisputeProofHanko).toBeUndefined();
  });

  test('R2C AccountSettled nonce zero retains a signed workspace for nonce one', async () => {
    const account = await signedWorkspaceAccount(1);
    const workspaceHash = account.settlementWorkspace!.workspaceHash;

    applyFinalizedAccountJEvents(account, RIGHT, [accountSettledEvent(0)], TEST_DELTA_TRANSFORMER);

    expect(account.jNonce).toBe(0);
    expect(account.settlementWorkspace?.workspaceHash).toBe(workspaceHash);
    expect(account.currentDisputeHash).toBeUndefined();
    expect(account.currentDisputeProofHanko).toBeUndefined();
  });

  test('AccountSettled finality rejects an event for a different bilateral pair before mutation', async () => {
    const account = await signedWorkspaceAccount(10);
    const event = accountSettledEvent(10);
    event.data.leftEntity = entity('33');
    event.data.collateral = '99';

    expect(() => applyFinalizedAccountJEvents(account, RIGHT, [event], TEST_DELTA_TRANSFORMER))
      .toThrow('ACCOUNT_SETTLED_PAIR_MISMATCH');

    expect(account.jNonce).toBe(0);
    expect(account.deltas.get(1)?.collateral).toBe(0n);
    expect(account.settlementWorkspace).toBeDefined();
  });

  test('matching AccountSettled nonce clears the workspace and activates its next proof', async () => {
    const account = await signedWorkspaceAccount(10);

    applyFinalizedAccountJEvents(account, RIGHT, [accountSettledEvent(10)], TEST_DELTA_TRANSFORMER);

    expect(account.jNonce).toBe(10);
    expect(account.settlementWorkspace).toBeUndefined();
    expect(account.currentDisputeHash).toBe(`0x${'82'.repeat(32)}`);
    expect(account.currentDisputeProofHanko).toBe('0x9abc');
    expect(account.counterpartyDisputeProofHanko).toBe('0xdef0');
    expect(account.proofHeader.nextProofNonce).toBe(12);
  });

  test('matching AccountSettled finality never rolls a newer signed proof frontier backward', async () => {
    const account = await signedWorkspaceAccount(2);
    account.currentDisputeProofNonce = 4;
    account.currentDisputeProofHanko = '0xaaaa';
    account.currentDisputeProofBodyHash = `0x${'a1'.repeat(32)}`;
    account.currentDisputeHash = `0x${'a2'.repeat(32)}`;
    account.counterpartyDisputeProofNonce = 5;
    account.counterpartyDisputeProofHanko = '0xbbbb';
    account.counterpartyDisputeProofBodyHash = `0x${'b1'.repeat(32)}`;
    account.counterpartyDisputeHash = `0x${'b2'.repeat(32)}`;
    account.proofHeader.nextProofNonce = 6;

    applyFinalizedAccountJEvents(account, RIGHT, [accountSettledEvent(2)], TEST_DELTA_TRANSFORMER);

    expect(account.jNonce).toBe(2);
    expect(account.settlementWorkspace).toBeUndefined();
    expect(account.currentDisputeProofNonce).toBe(4);
    expect(account.currentDisputeProofHanko).toBe('0xaaaa');
    expect(account.currentDisputeProofBodyHash).toBe(`0x${'a1'.repeat(32)}`);
    expect(account.currentDisputeHash).toBe(`0x${'a2'.repeat(32)}`);
    expect(account.counterpartyDisputeProofNonce).toBe(5);
    expect(account.counterpartyDisputeProofHanko).toBe('0xbbbb');
    expect(account.counterpartyDisputeProofBodyHash).toBe(`0x${'b1'.repeat(32)}`);
    expect(account.counterpartyDisputeHash).toBe(`0x${'b2'.repeat(32)}`);
    expect(account.proofHeader.nextProofNonce).toBe(6);
  });

  test('matching finality rejects a post-settlement proof that is not exactly nonce plus one', async () => {
    const account = await signedWorkspaceAccount(10);
    account.settlementWorkspace!.postSettlementDisputeProof!.nonce = 12;

    expect(() => applyFinalizedAccountJEvents(account, RIGHT, [accountSettledEvent(10)], TEST_DELTA_TRANSFORMER))
      .toThrow('POST_SETTLEMENT_PROOF_NONCE_MISMATCH');

    expect(account.settlementWorkspace).toBeDefined();
    expect(account.currentDisputeHash).toBeUndefined();
  });

  test('a signed workspace without its exact settlement nonce fails loud at finality', async () => {
    const account = await signedWorkspaceAccount(10);
    delete account.settlementWorkspace!.nonceAtSign;

    expect(() => applyFinalizedAccountJEvents(account, RIGHT, [accountSettledEvent(10)], TEST_DELTA_TRANSFORMER))
      .toThrow('SETTLEMENT_SIGNED_NONCE_MISSING');

    expect(account.settlementWorkspace).toBeDefined();
    expect(account.currentDisputeHash).toBeUndefined();
  });

  test('AccountSettled finality clears an unsigned workspace whose holds were based on old state', async () => {
    const account = makeAccount(LEFT, RIGHT);
    expect((await upsert(account, {
      version: 1,
      ops: [{ type: 'r2r', tokenId: 1, amount: 4n }],
      executorIsLeft: false,
    })).success).toBe(true);
    expect(account.deltas.get(1)?.leftHold).toBe(4n);

    applyFinalizedAccountJEvents(account, RIGHT, [accountSettledEvent(1)], TEST_DELTA_TRANSFORMER);

    expect(account.jNonce).toBe(1);
    expect(account.settlementWorkspace).toBeUndefined();
    expect(account.deltas.get(1)?.leftHold).toBe(0n);
  });

  test('R2C AccountSettled nonce zero clears an unsigned workspace with stale capacity holds', async () => {
    const account = makeAccount(LEFT, RIGHT);
    expect((await upsert(account, {
      version: 1,
      ops: [{ type: 'r2r', tokenId: 1, amount: 4n }],
      executorIsLeft: false,
    })).success).toBe(true);
    expect(account.jNonce).toBe(0);
    expect(account.deltas.get(1)?.leftHold).toBe(4n);

    applyFinalizedAccountJEvents(account, RIGHT, [accountSettledEvent(0)], TEST_DELTA_TRANSFORMER);

    expect(account.jNonce).toBe(0);
    expect(account.settlementWorkspace).toBeUndefined();
    expect(account.deltas.get(1)?.leftHold).toBe(0n);
  });

  test('multi-token AccountSettled events sharing one nonce finalize as one settlement', async () => {
    const account = makeAccount(LEFT, RIGHT);
    const token2 = createDefaultDelta(2);
    token2.leftCreditLimit = 100n;
    token2.rightCreditLimit = 100n;
    account.deltas.set(2, token2);
    expect((await upsert(account, {
      version: 1,
      ops: [
        { type: 'r2r', tokenId: 1, amount: 4n },
        { type: 'r2r', tokenId: 2, amount: 2n },
      ],
      executorIsLeft: false,
    })).success).toBe(true);
    account.settlementWorkspace!.leftHanko = '0x1234';
    account.settlementWorkspace!.rightHanko = '0x5678';
    account.settlementWorkspace!.nonceAtSign = 10;
    account.settlementWorkspace!.postSettlementDisputeProof = {
      leftHanko: '0x9abc',
      rightHanko: '0xdef0',
      disputeHash: `0x${'84'.repeat(32)}`,
      proofBodyHash: buildAccountProofBody(account, TEST_DELTA_TRANSFORMER).proofBodyHash,
      nonce: 11,
    };
    const token2Event = accountSettledEvent(10);
    token2Event.data.tokenId = 2;
    token2Event.data.collateral = '25';
    token2Event.data.ondelta = '7';

    applyFinalizedAccountJEvents(
      account,
      RIGHT,
      [accountSettledEvent(10), token2Event],
      TEST_DELTA_TRANSFORMER,
    );

    expect(account.jNonce).toBe(10);
    expect(account.settlementWorkspace).toBeUndefined();
    expect(account.deltas.get(1)?.leftHold).toBe(0n);
    expect(account.deltas.get(2)?.leftHold).toBe(0n);
    expect(account.deltas.get(2)?.collateral).toBe(25n);
    expect(account.deltas.get(2)?.ondelta).toBe(7n);
    expect(account.currentDisputeHash).toBe(`0x${'84'.repeat(32)}`);
  });

  test('newer AccountSettled nonce clears a stale workspace without activating its post proof', async () => {
    const account = await signedWorkspaceAccount(10);

    applyFinalizedAccountJEvents(account, RIGHT, [accountSettledEvent(12)], TEST_DELTA_TRANSFORMER);

    expect(account.jNonce).toBe(12);
    expect(account.settlementWorkspace).toBeUndefined();
    expect(account.currentDisputeHash).toBeUndefined();
    expect(account.currentDisputeProofHanko).toBeUndefined();
    expect(account.counterpartyDisputeProofHanko).toBeUndefined();
  });

  test('the highest nonce in a multi-event finalized claim governs post-proof activation', async () => {
    const account = await signedWorkspaceAccount(10);

    applyFinalizedAccountJEvents(account, RIGHT, [
      accountSettledEvent(10),
      accountSettledEvent(12),
    ], TEST_DELTA_TRANSFORMER);

    expect(account.jNonce).toBe(12);
    expect(account.settlementWorkspace).toBeUndefined();
    expect(account.currentDisputeHash).toBeUndefined();
    expect(account.currentDisputeProofHanko).toBeUndefined();
  });

  test('AccountSettled finality rejects missing or unsafe nonces loudly', async () => {
    const invalidNonces = [undefined, -1, 1.5, Number.MAX_SAFE_INTEGER + 1];
    for (const nonce of invalidNonces) {
      const account = await signedWorkspaceAccount(10);
      const invalidEvent = accountSettledEvent(10) as unknown as {
        type: 'AccountSettled';
        data: Record<string, unknown>;
      };
      invalidEvent.data['nonce'] = nonce;
      expect(() => applyFinalizedAccountJEvents(
        account,
        RIGHT,
        [invalidEvent as never],
        TEST_DELTA_TRANSFORMER,
      )).toThrow('ACCOUNT_SETTLED_NONCE_INVALID');
    }
  });

  test('aborting a stale J batch cannot delete a newer workspace or strand its holds', async () => {
    const env = createEmptyEnv('settlement-transition-stale-j-abort');
    const jurisdiction = makeJurisdiction('settlement-transition', 31337, 'a1', 'b2');
    const state = makeState(LEFT, addr('35'), jurisdiction, RIGHT);
    const account = state.accounts.get(RIGHT)!;
    expect((await upsert(account, {
      version: 1,
      ops: [{ type: 'r2r', tokenId: 1, amount: 4n }],
      executorIsLeft: false,
    })).success).toBe(true);
    const workspaceHash = account.settlementWorkspace!.workspaceHash;
    account.jNonce = 2;
    state.jBatchState = {
      batch: createEmptyBatch(),
      jurisdiction: null,
      lastBroadcast: 0,
      broadcastCount: 0,
      failedAttempts: 0,
      status: 'sent',
      sentBatch: {
        batch: {
          ...createEmptyBatch(),
          collateralToReserve: [{
            counterparty: RIGHT,
            tokenId: 1,
            amount: 1n,
            nonce: 1,
            sig: '0x1234',
          }],
        },
        batchHash: `0x${'44'.repeat(32)}`,
        encodedBatch: '0x',
        entityNonce: 1,
        firstSubmittedAt: 1_000,
        lastSubmittedAt: 1_000,
        submitAttempts: 1,
      },
      entityNonce: 1,
    };

    const result = await handleJAbortSentBatch(
      state,
      { type: 'j_abort_sent_batch', data: { requeueToCurrent: true, reason: 'stale' } },
      env,
    );
    const resultAccount = result.newState.accounts.get(RIGHT)!;

    expect(result.newState.jBatchState?.batch.collateralToReserve).toEqual([]);
    expect(resultAccount.settlementWorkspace?.workspaceHash).toBe(workspaceHash);
    expect(resultAccount.deltas.get(1)?.leftHold).toBe(4n);
  });

  test('restored Account state continues the same exact workspace hash/version chain', async () => {
    const live = makeAccount(LEFT, RIGHT);
    const first = await upsert(live, {
      version: 1,
      ops: [{ type: 'r2r', tokenId: 1, amount: 4n }],
      executorIsLeft: false,
    });
    expect(first.success).toBe(true);
    const restored = cloneAccountMachine(live, true);
    const previousWorkspaceHash = live.settlementWorkspace!.workspaceHash;
    const update = transition({
      kind: 'upsert',
      version: 2,
      previousWorkspaceHash,
      ops: [{ type: 'r2r', tokenId: 1, amount: 2n }],
      executorIsLeft: true,
      memo: 'after restore',
    });

    const [liveResult, restoredResult] = await Promise.all([
      applyAccountTx(live, update, true, 2_000),
      applyAccountTx(restored, update, true, 2_000),
    ]);

    expect(liveResult.success).toBe(true);
    expect(restoredResult.success).toBe(true);
    expect(restored.settlementWorkspace).toEqual(live.settlementWorkspace);
    expect(restored.deltas.get(1)?.leftHold).toBe(live.deltas.get(1)?.leftHold);
  });

  test('Account cloning isolates nested post-settlement proof signatures', async () => {
    const account = makeAccount(LEFT, RIGHT);
    expect((await upsert(account, {
      version: 1,
      ops: [{ type: 'r2r', tokenId: 1, amount: 4n }],
      executorIsLeft: false,
    })).success).toBe(true);
    account.settlementWorkspace!.postSettlementDisputeProof = {
      disputeHash: `0x${'61'.repeat(32)}`,
      proofBodyHash: `0x${'62'.repeat(32)}`,
      nonce: 2,
    };

    const clone = cloneAccountMachine(account);
    clone.settlementWorkspace!.postSettlementDisputeProof!.leftHanko = '0x1234';

    expect(account.settlementWorkspace?.postSettlementDisputeProof?.leftHanko).toBeUndefined();
    expect(clone.settlementWorkspace?.postSettlementDisputeProof?.leftHanko).toBe('0x1234');
  });
});
