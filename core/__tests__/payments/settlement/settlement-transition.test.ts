import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { applyAccountTx, applyAccountTxToMutableReplica } from '../../../account/tx/apply';
import { createAccountJClaimSession } from '../../../account/j-claims/j-claim-session';
import {
  cacheCommittedAccountJClaimNodeChanges,
  getAccountJClaimNodeStore,
} from '../../../entity/account/account-j-claim-node-store';
import { prepareAccountJClaimTx } from '../../../account/j-claims/j-claim-transition';
import { handleJEventClaim } from '../../../account/tx/handlers/j-events/claim';
import { createSettlementWorkspaceHash } from '../../../account/tx/handlers/settlement/transition';
import { applyEntityFrameWithMaterializedTestInfraContext } from '../../helpers/entity-frame';
import { selectSettlementContinuation } from '../../../entity/consensus/account/settlement-continuation';
import { proposeAccountFrame } from '../../../account/consensus/proposal/propose';
import {
  assertEntityStateRootCache,
  computeCanonicalEntityConsensusStateHash,
} from '../../../entity/consensus/state-root';
import { buildSignedEntityCommand } from '../../../entity/command';
import { signedEntityCommandTx } from '../../../entity/command/command-codec';
import { buildCollectiveEntityProposalTx } from '../../../entity/auth/authorization';
import {
  sealHankoWitnessInState,
  type HankoWitnessEntry,
} from '../../../entity/consensus/input/hanko-witness';
import { signEntityHashes } from '../../../hanko/signing';
import { generateLazyEntityId, generateNumberedEntityId } from '../../../entity/factory';
import {
  canAutoApproveWorkspace,
  buildSettlementSealDraft,
  handleSettleApprove,
  handleSettleExecute,
  handleSettlePropose,
  processCommittedSettlementTransitionFollowup,
} from '../../../entity/tx/handlers/payments/settle';
import { handleJAbortSentBatch } from '../../../entity/tx/handlers/j-batch/j-abort-sent-batch';
import {
  executeCrontab,
  HUB_REBALANCE_INTERVAL_MS,
  initCrontab,
} from '../../../entity/scheduler';
import { hubRebalanceHandler } from '../../../entity/scheduler/rebalance';
import { applyFinalizedAccountJEvents } from '../../../account/tx/handlers/j-events/finality';
import { createEmptyBatch, initJBatch } from '../../../jurisdiction/machine/batch';
import { buildAccountProofBody } from '../../../protocol/dispute/proof-builder';
import { compileOps } from '../../../protocol/settlement/operations';
import {
  applyCertifiedBoardRegistryEvent,
  cacheCertifiedBoardNodes,
  getCertifiedBoardNodeStore,
  resolveObserverCertifiedBoardHash,
} from '../../../jurisdiction/machine/board-registry';
import { createEmptyEnv } from '../../../runtime';
import { createAccountConsensusContext } from '../../../entity/account/account-consensus-context';
import { forkAccountReplicaShell } from '../../../account/state/account-replica-shell';
import type { AccountReplica, AccountTx, Delta, SettlementOp } from '../../../types/account';
import type { RebalanceRequestFeeState } from '../../../types/finance/rebalance';
import type { EntityState, HashToSign, JurisdictionConfig } from '../../../entity/types';
import type { RuntimeReplica } from '../../../runtime/types';
import type { JurisdictionEvent } from '../../../types/jurisdiction-events';
import { createDefaultDelta } from '../../../account/state/delta';
import { LIMITS, TOKENS } from '../../../config/constants';
import { getDefaultCreditLimit } from '../../../account/utils';
import { projectSettlementDeltaOverrides } from '../../../account/settlement/settlement-projection';
import { requirePersistentAccountStateMap } from '../../../account/state/persistent-state-map';
import {
  EntityAccountCandidateMap,
  PersistentEntityAccountMap,
} from '../../../entity/state/persistent-account-map';
import { commitEntityAccountCandidate } from '../../../entity/state/candidate-map';
import {
  accountTransitionView,
  beginAccountTransition,
  commitAccountTransition,
  discardAccountTransition,
} from '../../../account/state/candidate-overlay';
import {
  addReplica,
  addr,
  entity,
  makeAccount,
  makeJurisdiction,
  makeState,
  openWritableEntityAccounts,
  registerTestSigner,
} from '../../helpers/cross-j';

const LEFT = entity('11');
const RIGHT = entity('22');
const TEST_ACCOUNT_CONTRACT = addr('c1');
const TEST_DELTA_TRANSFORMER = addr('d1');

const transition = (data: Record<string, unknown>): AccountTx => ({
  type: 'settle_transition',
  data,
} as unknown as AccountTx);

const putDelta = (account: AccountReplica, delta: Delta): void => {
  account.state.deltas = requirePersistentAccountStateMap(account.state.deltas, 'deltas')
    .updated(delta.tokenId, delta);
};

const putRequestedRebalance = (
  account: AccountReplica,
  tokenId: number,
  amount: bigint,
): void => {
  account.state.requestedRebalance = requirePersistentAccountStateMap(
    account.state.requestedRebalance,
    'requestedRebalance',
  ).updated(tokenId, amount);
};

const putRequestedRebalanceFeeState = (
  account: AccountReplica,
  tokenId: number,
  feeState: RebalanceRequestFeeState,
): void => {
  account.state.requestedRebalanceFeeState = requirePersistentAccountStateMap(
    account.state.requestedRebalanceFeeState,
    'requestedRebalanceFeeState',
  ).updated(tokenId, feeState);
};

const writableAccount = (state: EntityState, counterpartyId: string): AccountReplica => {
  const replica = openWritableEntityAccounts(state).getForWrite(counterpartyId);
  if (!replica) throw new Error(`TEST_ACCOUNT_MISSING:${counterpartyId}`);
  return replica;
};

const sealWritableAccounts = (state: EntityState): void => {
  state.accounts = commitEntityAccountCandidate(state.accounts);
};

const applyEntityAccountTx = async (
  state: EntityState,
  counterpartyId: string,
  accountTx: AccountTx,
  byLeft: boolean,
  timestamp: number,
  consensusContext?: ReturnType<typeof createAccountConsensusContext>,
  isValidation = false,
  counterpartyCertifiedBoardHash?: string,
) => {
  const base = state.accounts.get(counterpartyId);
  if (!base) throw new Error(`TEST_ACCOUNT_MISSING:${counterpartyId}`);
  const owner = beginAccountTransition(base);
  const result = await applyAccountTx(
    accountTransitionView(owner),
    accountTx,
    byLeft,
    timestamp,
    0,
    isValidation,
    consensusContext,
    undefined,
    counterpartyCertifiedBoardHash,
  );
  if (!result.ok) {
    discardAccountTransition(owner);
    return result;
  }
  const committed = commitAccountTransition(owner);
  if (state.accounts instanceof PersistentEntityAccountMap) {
    state.accounts = state.accounts.updated(counterpartyId, committed.account);
  } else if (state.accounts instanceof EntityAccountCandidateMap) {
    state.accounts.set(counterpartyId, committed.account);
  } else {
    throw new Error('TEST_ENTITY_ACCOUNT_MAP_INVALID');
  }
  return result;
};

const upsert = async (
  account: ReturnType<typeof makeAccount>,
  data: {
    revision: number;
    previousWorkspaceHash?: string;
    ops: SettlementOp[];
    executorIsLeft: boolean;
    memo?: string;
  },
) => applyAccountTxToMutableReplica(account, transition({ kind: 'upsert', ...data }), true, 1_000);

const upsertOnState = async (
  state: EntityState,
  counterpartyId: string,
  data: {
    revision: number;
    previousWorkspaceHash?: string;
    ops: SettlementOp[];
    executorIsLeft: boolean;
    memo?: string;
  },
  byLeft = true,
) => applyEntityAccountTx(state, counterpartyId, transition({ kind: 'upsert', ...data }), byLeft, 1_000);

const applyOnEntity = async (
  state: EntityState,
  counterpartyId: string,
  accountTx: AccountTx,
  byLeft: boolean,
  timestamp = 1_000,
  consensusContext?: ReturnType<typeof createAccountConsensusContext>,
) => {
  const result = await applyEntityAccountTx(
    state,
    counterpartyId,
    accountTx,
    byLeft,
    timestamp,
    consensusContext,
  );
  return { result, account: writableAccount(state, counterpartyId) };
};

const signedWorkspaceAccount = async (nonceAtSign: number) => {
  const account = makeAccount(LEFT, RIGHT);
  expect((await upsert(account, {
    revision: 1,
    ops: [{ type: 'r2r', tokenId: 1, amount: 4n }],
    executorIsLeft: false,
  })).ok).toBe(true);
  const workspace = account.state.settlementWorkspace!;
  const compiled = compileOps(workspace.ops, true);
  workspace.compiledDiffs = compiled.diffs;
  workspace.compiledForgiveTokenIds = compiled.forgiveTokenIds;
  workspace.leftHanko = '0x1234';
  workspace.rightHanko = '0x5678';
  account.state.settlementWorkspace!.nonceAtSign = nonceAtSign;
  account.state.settlementWorkspace!.settlementHash = `0x${'81'.repeat(32)}`;
  const proofBodyHash = buildAccountProofBody(account, TEST_DELTA_TRANSFORMER).proofBodyHash;
  account.state.settlementWorkspace!.postSettlementDisputeProof = {
    leftHanko: '0x9abc',
    rightHanko: '0xdef0',
    disputeHash: `0x${'82'.repeat(32)}`,
    proofBodyHash,
    nonce: nonceAtSign + 1,
    proposerIsLeft: true,
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
  env: RuntimeReplica,
  observerState: EntityState,
  jurisdiction: JurisdictionConfig,
  boardHash: string,
  registeredEntityId = observerState.entityId,
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
      entityId: registeredEntityId,
      entityNumber: BigInt(registeredEntityId).toString(),
      boardHash,
    },
    blockNumber: 2,
    blockHash: `0x${'02'.repeat(32)}`,
    transactionHash: `0x${'12'.repeat(32)}`,
    logIndex: 0,
  }];
  for (const event of events) {
    const applied = applyCertifiedBoardRegistryEvent(
      observerState.certifiedBoardState,
      getCertifiedBoardNodeStore(env),
      jurisdiction,
      event,
    );
    cacheCertifiedBoardNodes(env, applied.newNodes);
    observerState.certifiedBoardState = applied.state;
  }
};

const installProofStack = (env: RuntimeReplica, state: EntityState): void => {
  const jurisdiction = state.config.jurisdiction;
  if (!jurisdiction) throw new Error('TEST_PROOF_JURISDICTION_MISSING');
  if (![...env.state.eReplicas.values()].some((replica) => replica.entityId === state.entityId)) {
    const signerId = state.config.validators[0];
    if (!signerId) throw new Error('TEST_PROOF_SIGNER_MISSING');
    addReplica(env, state, signerId);
  }
  env.state.jReplicas.set(jurisdiction.name, {
    name: jurisdiction.name,
    chainId: jurisdiction.chainId,
    contracts: { depository: jurisdiction.depositoryAddress, entityProvider: jurisdiction.entityProviderAddress },
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
  env: RuntimeReplica,
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
  const account = writableAccount(state, counterpartyId);
  account.mempool.push(tx);
  expect(sealHankoWitnessInState(state, witness, entityHeight, [counterpartyId])).toBe(hashesToSign.length);
  return account.mempool.at(-1) as Extract<AccountTx, { type: 'settle_transition' }>;
};

describe('atomic settlement Account transition', () => {
  test('hub rebalance rejects an over-limit R2C set without committing its valid prefix', async () => {
    const env = createEmptyEnv('rebalance-r2c-atomic-batch');
    const jurisdiction = makeJurisdiction('rebalance-r2c-atomic', 31337, 'a1', 'b2');
    const signer = registerTestSigner(env, 'rebalance-r2c-atomic-batch', '1');
    const state = makeState(LEFT, signer, jurisdiction, RIGHT);
    state.timestamp = 1_000;
    state.hubRebalanceConfig = {
      matchingStrategy: 'amount',
      policyVersion: 1,
      routingFeePPM: 0,
      baseFee: 0n,
      rebalanceLiquidityFeeBps: 0n,
    };
    state.jBatchState = initJBatch();
    state.reserves.set(1, 100n);
    state.reserves.set(2, 100n);
    const account = writableAccount(state, RIGHT);
    for (const tokenId of [1, 2]) {
      const delta = createDefaultDelta(tokenId);
      delta.offdelta = -100n;
      putDelta(account, delta);
      putRequestedRebalance(account, tokenId, 10n);
      putRequestedRebalanceFeeState(account, tokenId, {
        requestId: `request-${String(tokenId)}`,
        feeTokenId: tokenId,
        feePaidUpfront: 10n ** 30n,
        requestedAmount: 10n,
        policyVersion: 1,
        requestedAt: tokenId,
        requestedByLeft: false,
      });
    }
    state.jBatchState.batch.reserveToCollateral.push({
      receivingEntity: LEFT,
      tokenId: 1,
      pairs: [{ entity: RIGHT, amount: 1n }],
    });
    for (let index = 0; index < 49; index += 1) {
      state.jBatchState.batch.reserveToCollateral.push({
        receivingEntity: entity((index + 48).toString(16).padStart(2, '0')),
        tokenId: 1,
        pairs: [{ entity: RIGHT, amount: 1n }],
      });
    }
    addReplica(env, state, signer);
    const replica = env.state.eReplicas.values().next().value;
    if (!replica) throw new Error('REBALANCE_ATOMIC_TEST_REPLICA_MISSING');
    const before = computeCanonicalEntityConsensusStateHash(state);

    await expect(hubRebalanceHandler(
      env,
      replica,
      {
        method: 'hubRebalance',
        intervalMs: HUB_REBALANCE_INTERVAL_MS,
        lastRun: 0,
        enabled: true,
        params: {},
      },
      {
        manualBroadcastInInput: false,
        accountChanges: new Set(),
      },
    )).rejects.toThrow('J_BATCH_LIMIT_EXCEEDED');
    expect(computeCanonicalEntityConsensusStateHash(state)).toBe(before);
    expect(account.shadow.rebalance.submittedAtByToken.size).toBe(0);
  });

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

    expect((await upsertOnState(state, RIGHT, {
      revision: 1,
      ops: [{ type: 'c2r', tokenId: 1, amount: 1n }],
      executorIsLeft: true,
    })).ok).toBe(true);
    const account = writableAccount(state, RIGHT);
    account.state.settlementWorkspace!.rightHanko = '0x1234';
    expect(account.state.settlementWorkspace!.status).toBe('awaiting_counterparty');
    const replica = env.state.eReplicas.values().next().value;
    if (!replica) throw new Error('SETTLEMENT_SCHEDULER_TEST_REPLICA_MISSING');

    const outputs = await executeCrontab(env, replica, state.crontabState, {
      manualBroadcastInInput: false,
      accountChanges: new Set(),
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

    expect((await upsertOnState(state, RIGHT, {
      revision: 1,
      ops: [{ type: 'c2r', tokenId: 1, amount: 1n }],
      executorIsLeft: true,
    })).ok).toBe(true);
    const account = writableAccount(state, RIGHT);
    const workspace = account.state.settlementWorkspace!;
    workspace.status = 'ready_to_submit';
    workspace.rightHanko = '0x1234';
    account.mempool.push(transition({
      kind: 'submit',
      revision: workspace.revision,
      workspaceHash: workspace.workspaceHash,
    }));
    const workspaceBefore = structuredClone(workspace);
    const mempoolBefore = structuredClone(account.mempool);
    const batchBefore = structuredClone(state.jBatchState);
    const replica = env.state.eReplicas.values().next().value;
    if (!replica) throw new Error('SETTLEMENT_SCHEDULER_TEST_REPLICA_MISSING');

    const outputs = await executeCrontab(env, replica, state.crontabState, {
      manualBroadcastInInput: false,
      accountChanges: new Set(),
    });

    expect(outputs.flatMap(output => output.entityTxs ?? []).map(tx => tx.type))
      .not.toContain('settle_execute');
    expect(account.state.settlementWorkspace).toEqual(workspaceBefore);
    expect(account.mempool).toEqual(mempoolBefore);
    expect(state.jBatchState).toEqual(batchBefore);
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
    expect((await upsertOnState(rightState, leftEntity, {
      revision: 1,
      ops: [{ type: 'r2r', tokenId: 1, amount: 4n }],
      executorIsLeft: true,
    })).ok).toBe(true);
    const account = rightState.accounts.get(leftEntity)!;
    // Prime the certified Entity's persistent Account commitment. The frame
    // candidate must fork this cache and refresh the touched Account after all
    // proposal-envelope mutations, never fall back to a cold full scan.
    computeCanonicalEntityConsensusStateHash(rightState);

    const approve = {
      type: 'settle_approve',
      data: { counterpartyEntityId: leftEntity, workspaceHash: account.state.settlementWorkspace!.workspaceHash },
    } as const;
    const proposal = buildCollectiveEntityProposalTx(rightSigner, [approve]);
    const execution = await applyEntityFrameWithMaterializedTestInfraContext(env, rightState, [
      signedEntityCommandTx(buildSignedEntityCommand(env, rightState, rightSigner, [proposal])),
    ], 2_000);
    expect(assertEntityStateRootCache(execution.newState)).toBe(
      computeCanonicalEntityConsensusStateHash(execution.newState),
    );
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
    expect(sealHankoWitnessInState(execution.newState, witness, 1, [leftEntity])).toBe(2);
    const attached = execution.newState.accounts.get(leftEntity)?.mempool[0];
    if (attached?.type !== 'settle_transition' || attached.data.kind !== 'seal') {
      throw new Error('TEST_ATTACHED_SETTLEMENT_HANKO_MISSING');
    }
    expect(attached.data.settlementHanko).toBeDefined();
    expect(attached.data.postProof.hanko).toBeDefined();
    expect(computeCanonicalEntityConsensusStateHash(execution.newState)).toBe(unsignedEntityStateRoot);

    const nextExecution = await applyEntityFrameWithMaterializedTestInfraContext(env, execution.newState, [], 2_001);
    expect(assertEntityStateRootCache(nextExecution.newState)).toBe(
      computeCanonicalEntityConsensusStateHash(nextExecution.newState),
    );
    const proposed = nextExecution.newState.accounts.get(leftEntity)!;
    expect(proposed.mempool).toHaveLength(0);
    expect(proposed.pendingFrame?.accountTxs).toHaveLength(1);
    expect(proposed.pendingFrame?.accountTxs[0]).toEqual(attached);
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
    expect((await upsertOnState(state, counterparty, {
      revision: 1,
      ops: [{ type: 'r2r', tokenId: 1, amount: 4n }],
      executorIsLeft: true,
    })).ok).toBe(true);
    const account = writableAccount(state, counterparty);
    account.mempool.push({
      type: 'direct_payment',
      data: {
        tokenId: 1,
        amount: 1n,
        route: [self, counterparty],
        fromEntityId: self,
        toEntityId: counterparty,
        deliveryMode: 'direct',
      },
    });
    const workspaceHash = account.state.settlementWorkspace!.workspaceHash;

    const approved = await handleSettleApprove(state, {
      type: 'settle_approve',
      data: { counterpartyEntityId: counterparty, workspaceHash },
    }, env);
    expect(approved.hashesToSign).toBeUndefined();
    expect(approved.newState.deferredAccountProposals?.get(counterparty)).toBe(workspaceHash);
    expect(approved.newState.accounts.get(counterparty)?.mempool).toHaveLength(1);

    const drainedAccount = writableAccount(approved.newState, counterparty);
    drainedAccount.mempool = [];
    drainedAccount.proofHeader.nextProofNonce = 6;
    sealWritableAccounts(approved.newState);
    const materialized = await applyEntityFrameWithMaterializedTestInfraContext(env, approved.newState, [], 2_000);
    const seal = materialized.newState.accounts.get(counterparty)?.mempool[0];
    expect(materialized.newState.deferredAccountProposals?.has(counterparty)).toBe(false);
    expect(materialized.collectedHashes?.map(({ type }) => type)).toEqual(['settlement', 'dispute']);
    expect(seal).toMatchObject({
      type: 'settle_transition',
      data: { kind: 'seal', settlementNonce: 6, postProof: { nonce: 7 } },
    });

    writableAccount(materialized.newState, counterparty).proofHeader.nextProofNonce = 7;
    sealWritableAccounts(materialized.newState);
    await expect(proposeAccountFrame(
      createAccountConsensusContext(env),
      materialized.newState.accounts.get(counterparty)!,
      2_001,
    )).resolves.toMatchObject({
      ok: true,
      outcome: 'idle',
      message: 'Transactions deferred until signed settlement finalizes: 1',
    });
    const refreshed = await applyEntityFrameWithMaterializedTestInfraContext(env, materialized.newState, [], 2_001);
    const refreshedAccount = refreshed.newState.accounts.get(counterparty)!;
    expect(refreshed.newState.deferredAccountProposals?.has(counterparty)).toBe(false);
    expect(refreshed.collectedHashes?.map(({ type }) => type)).toEqual(['settlement', 'dispute']);
    expect(refreshedAccount.mempool).toHaveLength(1);
    expect(refreshedAccount.mempool[0]).toMatchObject({
      type: 'settle_transition',
      data: { kind: 'seal', settlementNonce: 7, postProof: { nonce: 8 } },
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
    const upsertTx = transition({
      kind: 'upsert',
      revision: 1,
      ops: [{ type: 'r2r', tokenId: 1, amount: 4n }],
      executorIsLeft: true,
    });
    expect((await applyEntityAccountTx(leftState, rightEntity, upsertTx, true, 1_000)).ok).toBe(true);
    expect((await applyEntityAccountTx(rightState, leftEntity, upsertTx, true, 1_000)).ok).toBe(true);
    const leftAccount = writableAccount(leftState, rightEntity);
    const rightAccount = writableAccount(rightState, leftEntity);

    const peerDraft = buildSettlementSealDraft(rightAccount, rightState, leftEntity, env);
    const peerSeal = await attachSettlementSealWitness(
      env,
      rightState,
      leftEntity,
      peerDraft.tx,
      peerDraft.hashesToSign,
      1,
    );
    expect((await applyEntityAccountTx(
      leftState,
      rightEntity,
      peerSeal,
      false,
      2_000,
      createAccountConsensusContext(env),
    )).ok).toBe(true);
    const leftAccountAfterSeal = writableAccount(leftState, rightEntity);
    expect(leftAccountAfterSeal.state.settlementWorkspace?.rightHanko).toBeDefined();
    expect(leftAccountAfterSeal.state.settlementWorkspace?.postSettlementDisputeProof?.rightHanko).toBeDefined();

    await processCommittedSettlementTransitionFollowup(
      leftAccountAfterSeal,
      peerSeal,
      {
        ...leftAccountAfterSeal.currentFrame,
        height: 1,
        timestamp: 2_000,
        accountTxs: [peerSeal],
        byLeft: false,
      },
      rightEntity,
      leftState,
      env,
    );
    const workspaceHash = leftAccountAfterSeal.state.settlementWorkspace!.workspaceHash;
    expect(leftState.deferredAccountProposals?.get(rightEntity)).toBe(workspaceHash);
    leftAccountAfterSeal.mempool.push({
      type: 'direct_payment',
      data: {
        tokenId: 1,
        amount: 1n,
        route: [leftEntity, rightEntity],
        fromEntityId: leftEntity,
        toEntityId: rightEntity,
        deliveryMode: 'direct',
      },
    });

    const materialized = await applyEntityFrameWithMaterializedTestInfraContext(env, leftState, [], 3_000);
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
      revision: 1,
      ops: [{ type: 'r2r', tokenId: 1, amount: 4n }],
      executorIsLeft: false,
    })).ok).toBe(true);
    account.proofHeader.nextProofNonce = 5;
    const workspaceHash = account.state.settlementWorkspace!.workspaceHash;
    const result = await applyAccountTxToMutableReplica(account, transition({
      kind: 'seal',
      revision: 1,
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

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected settlement seal nonce rejection');
    expect(result.rejection).toEqual({
      kind: 'settlement_seal_nonce_mismatch',
      code: 'SETTLEMENT_SEAL_NONCE_MISMATCH',
      message: 'SETTLEMENT_SEAL_NONCE_MISMATCH:6:5:j=0:next=5:local=0:peer=0',
      suppliedNonce: 6,
      requiredNonce: 5,
      basis: 'account',
    });
    expect(account.state.settlementWorkspace?.nonceAtSign).toBeUndefined();
    expect(account.state.settlementWorkspace?.leftHanko).toBeUndefined();
    expect(account.state.settlementWorkspace?.postSettlementDisputeProof).toBeUndefined();
  });

  test('workspace hash binds parties, revision, ops, modifier side, executor, and memo only', () => {
    const leftView = makeAccount(LEFT, RIGHT);
    const rightView = makeAccount(RIGHT, LEFT);
    const body = {
      revision: 1,
      ops: [{ type: 'r2r' as const, tokenId: 1, amount: 4n }],
      lastModifiedByLeft: true,
      executorIsLeft: false,
      memo: 'canonical',
    };
    const hash = createSettlementWorkspaceHash(leftView.state, body);
    expect(createSettlementWorkspaceHash(rightView.state, body)).toBe(hash);
    expect(createSettlementWorkspaceHash(leftView.state, { ...body, revision: 2 })).not.toBe(hash);
    expect(createSettlementWorkspaceHash(leftView.state, { ...body, executorIsLeft: true })).not.toBe(hash);
    expect(createSettlementWorkspaceHash(leftView.state, { ...body, memo: 'different' })).not.toBe(hash);
    expect(createSettlementWorkspaceHash(leftView.state, {
      ...body,
      ops: [{ type: 'r2r', tokenId: 1, amount: 5n }],
    })).not.toBe(hash);
    expect(createSettlementWorkspaceHash(makeAccount(entity('01'), RIGHT).state, body)).not.toBe(hash);
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

    expect(result.newState.accounts.get(RIGHT)?.state.settlementWorkspace).toBeUndefined();
    expect(result.outputs).toEqual([]);
    expect(result.accountTxs).toHaveLength(1);
    expect(result.accountTxs[0]?.tx).toMatchObject({
      type: 'settle_transition',
      data: { kind: 'upsert', revision: 1, executorIsLeft: false },
    });
  });

  test('Entity proposal commits an exact continuation hash beside the Account transition', async () => {
    const env = createEmptyEnv('settlement-transition-continuation-proposal');
    const jurisdiction = makeJurisdiction('settlement-transition', 31337, 'a1', 'b2');
    const leftState = makeState(LEFT, addr('31'), jurisdiction, RIGHT);
    const ops = [{ type: 'c2r' as const, tokenId: 1, amount: 4n }];
    const result = await handleSettlePropose(leftState, {
      type: 'settle_propose',
      data: {
        counterpartyEntityId: RIGHT,
        ops,
        executorIsLeft: true,
        continuation: {
          actions: [{ type: 'r2r', toEntityId: entity('33'), tokenId: 1, amount: 4n }],
          broadcast: true,
        },
      },
    }, env);

    const continuation = result.newState.settlementContinuations?.get(RIGHT);
    expect(continuation).toEqual({
      workspaceHash: createSettlementWorkspaceHash(
        result.newState.accounts.get(RIGHT)!.state,
        {
          revision: 1,
          ops,
          lastModifiedByLeft: true,
          executorIsLeft: true,
        },
      ),
      actions: [{ type: 'r2r', toEntityId: entity('33'), tokenId: 1, amount: 4n }],
      broadcast: true,
    });
  });

  test('continuation executes once only for its exact ready workspace and an empty J draft', () => {
    const jurisdiction = makeJurisdiction('settlement-transition', 31337, 'a1', 'b2');
    const state = makeState(LEFT, addr('31'), jurisdiction, RIGHT);
    const account = writableAccount(state, RIGHT);
    const workspace = {
      workspaceHash: '',
      ops: [{ type: 'c2r' as const, tokenId: 1, amount: 4n }],
      lastModifiedByLeft: true,
      status: 'ready_to_submit' as const,
      revision: 1,
      createdAt: 1,
      lastUpdatedAt: 2,
      executorIsLeft: true,
    };
    workspace.workspaceHash = createSettlementWorkspaceHash(account.state, workspace);
    account.state.settlementWorkspace = workspace;
    state.settlementContinuations = new Map([[
      RIGHT,
      {
        workspaceHash: workspace.workspaceHash,
        actions: [{ type: 'r2e', receivingEntity: entity('44'), tokenId: 1, amount: 4n }],
        broadcast: true,
      },
    ]]);

    expect(selectSettlementContinuation(state)).toEqual({
      kind: 'execute',
      counterpartyId: RIGHT,
      txs: [
        {
          type: 'settle_execute',
          data: { counterpartyEntityId: RIGHT, disableC2RShortcut: true },
        },
        {
          type: 'r2e',
          data: { receivingEntity: entity('44'), tokenId: 1, amount: 4n },
        },
        { type: 'j_broadcast', data: {} },
      ],
    });

    state.jBatchState = initJBatch();
    state.jBatchState.batch.reserveToReserve.push({
      receivingEntity: entity('55'),
      tokenId: 1,
      amount: 1n,
    });
    expect(selectSettlementContinuation(state)).toEqual({
      kind: 'wait',
      counterpartyId: RIGHT,
    });

    state.jBatchState = initJBatch();
    account.state.settlementWorkspace = { ...workspace, memo: 'collision' };
    account.state.settlementWorkspace.workspaceHash = createSettlementWorkspaceHash(
      account.state,
      account.state.settlementWorkspace,
    );
    expect(selectSettlementContinuation(state)).toEqual({
      kind: 'discard',
      counterpartyId: RIGHT,
      reason: 'workspace_changed',
    });
  });

  test('an Account frame creates the workspace and its holds without Entity-local prestate', async () => {
    const account = makeAccount(LEFT, RIGHT);

    const result = await upsert(account, {
      revision: 1,
      ops: [{ type: 'r2r', tokenId: 1, amount: 4n }],
      executorIsLeft: false,
      memo: 'frame-only proposal',
    });

    expect(result.ok).toBe(true);
    expect(account.state.settlementWorkspace).toMatchObject({
      revision: 1,
      lastModifiedByLeft: true,
      executorIsLeft: false,
      memo: 'frame-only proposal',
      status: 'awaiting_counterparty',
    });
    expect(account.state.settlementWorkspace?.workspaceHash).toMatch(/^0x[0-9a-f]{64}$/);
    expect(account.state.deltas.get(1)?.leftHold).toBe(4n);
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
    const tx = transition({
      kind: 'upsert',
      revision: 1,
      ops: [{ type: 'r2r', tokenId: 1, amount: 4n }],
      executorIsLeft: true,
    });

    expect(rightState.accounts.get(LEFT)?.state.settlementWorkspace).toBeUndefined();
    const { result: applied, account: rightAccount } = await applyOnEntity(rightState, LEFT, tx, true);
    expect(applied.ok).toBe(true);
    expect(rightAccount.state.settlementWorkspace?.rightHanko).toBeUndefined();

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
    expect(rightAccount.state.settlementWorkspace?.rightHanko).toBeUndefined();
    expect(followup.outputs).toEqual([]);
    expect(followup.accountTxs).toEqual([]);
    expect(followup.hashesToSign).toEqual([]);
    expect(rightState.deferredAccountProposals?.get(LEFT))
      .toBe(rightAccount.state.settlementWorkspace?.workspaceHash);
  });

  test('pure debt forgiveness is never classified as safe for automatic approval', async () => {
    const pureForgiveness = makeAccount(LEFT, RIGHT);
    expect((await upsert(pureForgiveness, {
      revision: 1,
      ops: [{ type: 'forgive', tokenId: 1 }],
      executorIsLeft: true,
    })).ok).toBe(true);
    expect(canAutoApproveWorkspace(pureForgiveness.state.settlementWorkspace!, false)).toBe(false);
  });

  test('a committed rawDiff never auto-seals for its counterparty', async () => {
    const env = createEmptyEnv('settlement-transition-raw-diff-manual-only');
    const jurisdiction = makeJurisdiction('settlement-transition', 31337, 'a1', 'b2');
    const leftSigner = registerTestSigner(env, 'settlement-transition-raw-diff-manual-only', '1');
    const rightSigner = registerTestSigner(env, 'settlement-transition-raw-diff-manual-only', '2');
    const leftState = makeState(LEFT, leftSigner, jurisdiction, RIGHT);
    const rightState = makeState(RIGHT, rightSigner, jurisdiction, LEFT);
    addReplica(env, leftState, leftSigner);
    addReplica(env, rightState, rightSigner);
    const tx = transition({
      kind: 'upsert',
      revision: 1,
      ops: [{
        type: 'rawDiff',
        tokenId: 1,
        leftDiff: 0n,
        rightDiff: 0n,
        collateralDiff: 0n,
        ondeltaDiff: 1n,
      }],
      executorIsLeft: true,
    });

    const { result: applied, account: rightAccount } = await applyOnEntity(rightState, LEFT, tx, true);
    expect(applied.ok).toBe(true);
    expect(canAutoApproveWorkspace(rightAccount.state.settlementWorkspace!, false)).toBe(false);

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

    expect(followup).toEqual({ outputs: [], accountTxs: [], hashesToSign: [] });
    expect(rightState.deferredAccountProposals?.has(LEFT) ?? false).toBe(false);
    expect(rightAccount.state.settlementWorkspace?.rightHanko).toBeUndefined();
  });

  test('settlement ops reject token ids outside the canonical Account domain', async () => {
    const account = makeAccount(LEFT, RIGHT);
    const result = await upsert(account, {
      revision: 1,
      ops: [{ type: 'forgive', tokenId: TOKENS.MAX_TOKEN_ID + 1 }],
      executorIsLeft: true,
    });

    expect(result.ok).toBe(false);
    expect(result.ok ? undefined : result.rejection.message).toContain('SETTLEMENT_TOKEN_INVALID');
    expect(account.state.settlementWorkspace).toBeUndefined();
  });

  test('settlement projection bounds new token rows and preserves default credit policy', () => {
    const account = makeAccount(LEFT, RIGHT);
    const projected = projectSettlementDeltaOverrides(account, [], [9]);
    const projectedDelta = projected.get(9);
    const defaultCredit = getDefaultCreditLimit(9);
    expect(projectedDelta?.leftCreditLimit).toBe(defaultCredit);
    expect(projectedDelta?.rightCreditLimit).toBe(defaultCredit);
    expect(account.state.deltas.has(9)).toBe(false);

    for (let tokenId = 2; tokenId <= LIMITS.MAX_ACCOUNT_TOKEN_ROWS; tokenId += 1) {
      putDelta(account, createDefaultDelta(tokenId));
    }
    expect(account.state.deltas.size).toBe(LIMITS.MAX_ACCOUNT_TOKEN_ROWS);
    expect(() => projectSettlementDeltaOverrides(account, [], [TOKENS.MAX_TOKEN_ID]))
      .toThrow('ACCOUNT_DELTA_ROW_LIMIT_EXCEEDED:insert');
    expect(account.state.deltas.size).toBe(LIMITS.MAX_ACCOUNT_TOKEN_ROWS);
    expect(account.state.deltas.has(TOKENS.MAX_TOKEN_ID)).toBe(false);
  });

  test('pure forgiveness pre-signs a post-settlement proof containing the newly observed token slot', async () => {
    const jurisdiction = makeJurisdiction('settlement-forgiveness-proof', 31337, 'a8', 'b9');
    const state = makeState(LEFT, addr('38'), jurisdiction, RIGHT);
    const tokenId = 9;
    expect(state.accounts.get(RIGHT)?.state.deltas.has(tokenId)).toBe(false);
    expect((await upsertOnState(state, RIGHT, {
      revision: 1,
      ops: [{ type: 'forgive', tokenId }],
      executorIsLeft: true,
    })).ok).toBe(true);
    const account = writableAccount(state, RIGHT);

    const env = createEmptyEnv('settlement-forgiveness-proof');
    installProofStack(env, state);
    const draft = buildSettlementSealDraft(account, state, RIGHT, env).tx;
    if (draft.type !== 'settle_transition' || draft.data.kind !== 'seal') {
      throw new Error('TEST_FORGIVENESS_SETTLEMENT_SEAL_MISSING');
    }
    const expected = forkAccountReplicaShell(account);
    putDelta(expected, createDefaultDelta(tokenId));
    expect(draft.data.postProof.proofBodyHash)
      .toBe(buildAccountProofBody(expected, TEST_DELTA_TRANSFORMER).proofBodyHash);
    expect(draft.data.postProof.proofBodyHash)
      .not.toBe(buildAccountProofBody(account, TEST_DELTA_TRANSFORMER).proofBodyHash);
  });

  test('pure-forgiveness AccountSettled finality activates the exact projected recovery proof', async () => {
    const jurisdiction = makeJurisdiction('settlement-forgiveness-finality', 31337, 'aa', 'bb');
    const state = makeState(LEFT, addr('39'), jurisdiction, RIGHT);
    const tokenId = 9;
    expect((await upsertOnState(state, RIGHT, {
      revision: 1,
      ops: [{ type: 'forgive', tokenId }],
      executorIsLeft: true,
    })).ok).toBe(true);
    const account = writableAccount(state, RIGHT);
    const env = createEmptyEnv('settlement-forgiveness-finality');
    installProofStack(env, state);
    const draft = buildSettlementSealDraft(account, state, RIGHT, env).tx;
    if (draft.type !== 'settle_transition' || draft.data.kind !== 'seal') {
      throw new Error('TEST_FORGIVENESS_SETTLEMENT_SEAL_MISSING');
    }
    const workspace = account.state.settlementWorkspace!;
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

    expect(account.state.deltas.has(tokenId)).toBe(true);
    expect(account.currentDisputeProofBodyHash).toBe(draft.data.postProof.proofBodyHash);
    expect(account.counterpartyDisputeProofBodyHash).toBe(draft.data.postProof.proofBodyHash);
    expect(account.currentDisputeProofNonce).toBe(draft.data.postProof.nonce);
    expect(account.state.settlementWorkspace).toBeUndefined();
  });

  test('a mixed workspace containing debt forgiveness always requires explicit approval', async () => {
    const mixedForgiveness = makeAccount(LEFT, RIGHT);
    expect((await upsert(mixedForgiveness, {
      revision: 1,
      ops: [
        { type: 'r2r', tokenId: 1, amount: 4n },
        { type: 'forgive', tokenId: 1 },
      ],
      executorIsLeft: true,
    })).ok).toBe(true);
    expect(canAutoApproveWorkspace(mixedForgiveness.state.settlementWorkspace!, false)).toBe(false);
  });

  test('non-executor settlement execution fails before creating any J batch state', async () => {
    const env = createEmptyEnv('settlement-transition-non-executor');
    const jurisdiction = makeJurisdiction('settlement-transition', 31337, 'a1', 'b2');
    const leftSigner = registerTestSigner(env, 'settlement-transition-non-executor', '1');
    const leftState = makeState(LEFT, leftSigner, jurisdiction, RIGHT);
    addReplica(env, leftState, leftSigner);
    expect((await upsertOnState(leftState, RIGHT, {
      revision: 1,
      ops: [{ type: 'r2r', tokenId: 1, amount: 4n }],
      executorIsLeft: false,
    })).ok).toBe(true);
    const account = writableAccount(leftState, RIGHT);
    account.state.settlementWorkspace!.rightHanko = '0x1234';
    account.state.settlementWorkspace!.nonceAtSign = 1;
    account.state.settlementWorkspace!.settlementHash = `0x${'91'.repeat(32)}`;

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
    expect((await upsertOnState(leftState, RIGHT, {
      revision: 1,
      ops: [{ type: 'r2r', tokenId: 1, amount: 4n }],
      executorIsLeft: true,
    })).ok).toBe(true);
    const account = writableAccount(leftState, RIGHT);
    account.state.settlementWorkspace!.rightHanko = '0x1234';
    account.state.settlementWorkspace!.settlementHash = `0x${'92'.repeat(32)}`;

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
    expect((await upsertOnState(leftState, RIGHT, {
      revision: 1,
      ops: [{ type: 'r2r', tokenId: 1, amount: 4n }],
      executorIsLeft: true,
    })).ok).toBe(true);
    const account = writableAccount(leftState, RIGHT);
    account.state.settlementWorkspace!.rightHanko = '0x1234';
    account.state.settlementWorkspace!.nonceAtSign = 1;

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
    const tx = transition({
      kind: 'upsert',
      revision: 1,
      ops: [{ type: 'r2r', tokenId: 1, amount: 4n }],
      executorIsLeft: true,
    });
    expect((await applyEntityAccountTx(rightState, leftEntity, tx, true, 1_000)).ok).toBe(true);
    expect((await applyEntityAccountTx(leftState, rightEntity, tx, true, 1_000)).ok).toBe(true);
    const rightAccount = rightState.accounts.get(leftEntity)!;
    const leftAccount = leftState.accounts.get(rightEntity)!;

    const rightApproval = await handleSettleApprove(
      rightState,
      {
        type: 'settle_approve',
        data: { counterpartyEntityId: leftEntity, workspaceHash: rightAccount.state.settlementWorkspace!.workspaceHash },
      },
      rightEnv,
    );
    expect(rightApproval.outputs).toEqual([]);
    expect(rightApproval.newState.deferredAccountProposals?.get(leftEntity))
      .toBe(rightAccount.state.settlementWorkspace!.workspaceHash);
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
    expect((await applyEntityAccountTx(
      rightSealingState,
      leftEntity,
      sealedRightTx,
      false,
      2_000,
      createAccountConsensusContext(rightEnv),
    )).ok).toBe(true);
    expect((await applyEntityAccountTx(
      leftState,
      rightEntity,
      sealedRightTx,
      false,
      2_000,
      createAccountConsensusContext(rightEnv),
    )).ok).toBe(true);

    const leftApproval = await handleSettleApprove(
      leftState,
      {
        type: 'settle_approve',
        data: {
          counterpartyEntityId: rightEntity,
          workspaceHash: leftState.accounts.get(rightEntity)!.state.settlementWorkspace!.workspaceHash,
        },
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
    expect((await applyEntityAccountTx(
      leftSealingState,
      rightEntity,
      sealedLeftTx,
      true,
      3_000,
      createAccountConsensusContext(rightEnv),
    )).ok).toBe(true);
    expect((await applyEntityAccountTx(
      rightSealingState,
      leftEntity,
      sealedLeftTx,
      true,
      3_000,
      createAccountConsensusContext(rightEnv),
    )).ok).toBe(true);

    const finalizedLeftWorkspace = leftSealingState.accounts.get(rightEntity)!.state.settlementWorkspace!;
    const finalizedRightWorkspace = rightSealingState.accounts.get(leftEntity)!.state.settlementWorkspace!;
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
    installRegisteredBoard(
      env,
      rightState,
      jurisdiction,
      registeredBoardHash,
      leftEntity,
    );
    expect(resolveObserverCertifiedBoardHash(
      rightState,
      getCertifiedBoardNodeStore(env),
      leftEntity,
    )).toBe(registeredBoardHash);

    const upsertTx = transition({
      kind: 'upsert',
      revision: 1,
      ops: [{ type: 'r2r', tokenId: 1, amount: 4n }],
      executorIsLeft: false,
    });
    expect((await applyEntityAccountTx(leftState, rightEntity, upsertTx, false, 1_000)).ok).toBe(true);
    expect((await applyEntityAccountTx(rightState, leftEntity, upsertTx, false, 1_000)).ok).toBe(true);

    const approval = await handleSettleApprove(
      leftState,
      {
        type: 'settle_approve',
        data: {
          counterpartyEntityId: rightEntity,
          workspaceHash: leftState.accounts.get(rightEntity)!.state.settlementWorkspace!.workspaceHash,
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
    const result = await applyEntityAccountTx(
      sealingState,
      rightEntity,
      sealedTx,
      true,
      2_000,
      createAccountConsensusContext(env, getAccountJClaimNodeStore(env), sealingState),
    );
    expect(result).toMatchObject({ ok: true });
    expect(sealingState.accounts.get(rightEntity)!.state.settlementWorkspace?.leftHanko).toBeDefined();
    const receiverResult = await applyEntityAccountTx(
      rightState,
      leftEntity,
      sealedTx,
      true,
      2_000,
      createAccountConsensusContext(env, getAccountJClaimNodeStore(env), rightState),
      true,
      registeredBoardHash,
    );
    expect(receiverResult).toMatchObject({ ok: true });
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
    const first = transition({
      kind: 'upsert',
      revision: 1,
      ops: [{ type: 'r2r', tokenId: 1, amount: 4n }],
      executorIsLeft: false,
    });
    expect((await applyEntityAccountTx(rightState, LEFT, first, true, 1_000)).ok).toBe(true);
    const account = writableAccount(rightState, LEFT);
    const second = transition({
      kind: 'upsert',
      revision: 2,
      previousWorkspaceHash: account.state.settlementWorkspace!.workspaceHash,
      ops: [{ type: 'r2r', tokenId: 1, amount: 2n }],
      executorIsLeft: false,
    });
    expect((await applyEntityAccountTx(rightState, LEFT, second, true, 1_001)).ok).toBe(true);
    const afterSecond = writableAccount(rightState, LEFT);
    const frame = {
      ...afterSecond.currentFrame,
      height: 1,
      timestamp: 1_001,
      accountTxs: [first, second],
      byLeft: true,
    };

    const staleFollowup = await processCommittedSettlementTransitionFollowup(
      afterSecond,
      first,
      frame,
      LEFT,
      rightState,
      env,
    );
    const finalFollowup = await processCommittedSettlementTransitionFollowup(
      afterSecond,
      second,
      frame,
      LEFT,
      rightState,
      env,
    );

    expect(staleFollowup).toEqual({ outputs: [], accountTxs: [], hashesToSign: [] });
    expect(finalFollowup.outputs).toEqual([]);
    expect(finalFollowup.accountTxs).toEqual([]);
    expect(finalFollowup.hashesToSign).toEqual([]);
    expect(rightState.deferredAccountProposals?.get(LEFT))
      .toBe(afterSecond.state.settlementWorkspace?.workspaceHash);
  });

  test('a multi-token update plans on owned leaves and publishes old-release/new-add atomically', async () => {
    const account = makeAccount(LEFT, RIGHT);
    const token2 = createDefaultDelta(2);
    token2.leftCreditLimit = 100n;
    token2.rightCreditLimit = 100n;
    const unrelated = createDefaultDelta(3);
    unrelated.leftHold = 9n;
    unrelated.rightHold = 8n;
    putDelta(account, token2);
    putDelta(account, unrelated);

    const first = await upsert(account, {
      revision: 1,
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
    expect(first.ok).toBe(true);
    const firstHash = account.state.settlementWorkspace?.workspaceHash;
    expect(firstHash).toMatch(/^0x[0-9a-f]{64}$/);
    expect(account.state.deltas.get(1)?.leftHold).toBe(3n);
    expect(account.state.deltas.get(2)?.rightHold).toBe(2n);

    const invalid = await upsert(account, {
      revision: 2,
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

    expect(invalid.ok).toBe(false);
    expect(account.state.settlementWorkspace?.workspaceHash).toBe(firstHash);
    expect(account.state.settlementWorkspace?.revision).toBe(1);
    expect(account.state.deltas.get(1)?.leftHold).toBe(3n);
    expect(account.state.deltas.get(2)?.rightHold).toBe(2n);
    expect(account.state.deltas.get(3)?.leftHold).toBe(9n);
    expect(account.state.deltas.get(3)?.rightHold).toBe(8n);

    const valid = await upsert(account, {
      revision: 2,
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

    expect(valid.ok).toBe(true);
    expect(account.state.settlementWorkspace?.revision).toBe(2);
    expect(account.state.settlementWorkspace?.workspaceHash).not.toBe(firstHash);
    expect(account.state.settlementWorkspace?.lastModifiedByLeft).toBe(true);
    expect(account.state.deltas.get(1)?.leftHold).toBe(1n);
    expect(account.state.deltas.get(2)?.rightHold).toBe(4n);
    expect(account.state.deltas.get(3)?.leftHold).toBe(9n);
    expect(account.state.deltas.get(3)?.rightHold).toBe(8n);
  });

  test('submit requires the elected executor and exact workspace hash, then releases only workspace holds', async () => {
    const account = makeAccount(LEFT, RIGHT);
    putDelta(account, { ...account.state.deltas.get(1)!, rightHold: 7n });
    const first = await upsert(account, {
      revision: 1,
      ops: [{ type: 'r2r', tokenId: 1, amount: 4n }],
      executorIsLeft: false,
    });
    expect(first.ok).toBe(true);
    const workspaceHash = account.state.settlementWorkspace!.workspaceHash;
    const compiled = compileOps(account.state.settlementWorkspace!.ops, true);
    account.state.settlementWorkspace!.compiledDiffs = compiled.diffs;
    account.state.settlementWorkspace!.compiledForgiveTokenIds = compiled.forgiveTokenIds;
    account.state.settlementWorkspace!.leftHanko = '0x1234';
    account.state.settlementWorkspace!.nonceAtSign = 1;
    account.state.settlementWorkspace!.settlementHash = `0x${'41'.repeat(32)}`;
    account.state.settlementWorkspace!.postSettlementDisputeProof = {
      leftHanko: '0x5678',
      rightHanko: '0x9abc',
      disputeHash: `0x${'42'.repeat(32)}`,
      proofBodyHash: `0x${'43'.repeat(32)}`,
      nonce: 2,
      proposerIsLeft: true,
    };
    account.state.settlementWorkspace!.status = 'ready_to_submit';

    const wrongSide = await applyAccountTxToMutableReplica(account, transition({
      kind: 'submit',
      revision: 1,
      workspaceHash,
    }), true, 2_000);
    expect(wrongSide.ok).toBe(false);
    expect(account.state.settlementWorkspace?.status).toBe('ready_to_submit');
    expect(account.state.deltas.get(1)?.leftHold).toBe(4n);
    expect(account.state.deltas.get(1)?.rightHold).toBe(7n);

    const submitted = await applyAccountTxToMutableReplica(account, transition({
      kind: 'submit',
      revision: 1,
      workspaceHash,
    }), false, 2_001);
    expect(submitted.ok).toBe(true);
    expect(account.state.settlementWorkspace?.status).toBe('submitted');
    expect(account.state.deltas.get(1)?.leftHold).toBe(0n);
    expect(account.state.deltas.get(1)?.rightHold).toBe(7n);
  });

  test('clear derives releases from the exact active workspace and removes it atomically', async () => {
    const account = makeAccount(LEFT, RIGHT);
    const first = await upsert(account, {
      revision: 1,
      ops: [{ type: 'r2r', tokenId: 1, amount: 4n }],
      executorIsLeft: false,
    });
    expect(first.ok).toBe(true);
    const workspaceHash = account.state.settlementWorkspace!.workspaceHash;

    const mismatched = await applyAccountTxToMutableReplica(account, transition({
      kind: 'clear',
      revision: 1,
      workspaceHash: `0x${'ff'.repeat(32)}`,
    }), false, 2_000);
    expect(mismatched.ok).toBe(false);
    expect(account.state.settlementWorkspace?.workspaceHash).toBe(workspaceHash);
    expect(account.state.deltas.get(1)?.leftHold).toBe(4n);

    const cleared = await applyAccountTxToMutableReplica(account, transition({
      kind: 'clear',
      revision: 1,
      workspaceHash,
    }), false, 2_001);
    expect(cleared.ok).toBe(true);
    expect(account.state.settlementWorkspace).toBeUndefined();
    expect(account.state.deltas.get(1)?.leftHold).toBe(0n);
  });

  test('a finalized disputed Account permanently rejects financial Account txs', async () => {
    const account = await signedWorkspaceAccount(10);
    const beforeOffdelta = account.state.deltas.get(1)?.offdelta;

    const payment = await applyAccountTxToMutableReplica(account, {
      type: 'direct_payment',
      data: {
        tokenId: 1,
        amount: 1n,
        route: [LEFT, RIGHT],
        fromEntityId: LEFT,
        toEntityId: RIGHT,
        deliveryMode: 'direct',
      },
    }, true, 2_000);
    expect(payment.ok).toBe(false);
    expect(payment.ok ? undefined : payment.rejection.message).toBe('SETTLEMENT_SIGNED_ACCOUNT_FROZEN:direct_payment');
    expect(payment.ok ? undefined : payment.rejection).toMatchObject({
      kind: 'settlement_signed_account_frozen',
      txType: 'direct_payment',
    });
    expect(account.state.deltas.get(1)?.offdelta).toBe(beforeOffdelta);

    account.status = 'disputed';
    const finalizedNonce = account.state.jNonce;
    const afterFinality = await applyAccountTxToMutableReplica(account, {
      type: 'direct_payment',
      data: {
        tokenId: 1,
        amount: 1n,
        route: [LEFT, RIGHT],
        fromEntityId: LEFT,
        toEntityId: RIGHT,
        deliveryMode: 'direct',
      },
    }, true, 2_001);
    expect(afterFinality.ok).toBe(false);
    expect(afterFinality.ok ? undefined : afterFinality.rejection.message).toBe('ACCOUNT_CLOSED_FOR_DISPUTE:status=disputed;tx=direct_payment');
    expect(account.status).toBe('disputed');
    expect(account.state.jNonce).toBe(finalizedNonce);
  });

  test('AccountSettled finality wins a submit retry race by releasing exact workspace holds', async () => {
    const account = makeAccount(LEFT, RIGHT);
    putDelta(account, { ...account.state.deltas.get(1)!, rightHold: 6n });
    const first = await upsert(account, {
      revision: 1,
      ops: [{ type: 'r2r', tokenId: 1, amount: 4n }],
      executorIsLeft: false,
    });
    expect(first.ok).toBe(true);
    account.state.settlementWorkspace!.leftHanko = '0x1234';
    account.state.settlementWorkspace!.nonceAtSign = 1;
    account.state.settlementWorkspace!.settlementHash = `0x${'51'.repeat(32)}`;
    account.state.settlementWorkspace!.postSettlementDisputeProof = {
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

    expect(account.state.settlementWorkspace).toBeUndefined();
    expect(account.state.deltas.get(1)?.leftHold).toBe(0n);
    expect(account.state.deltas.get(1)?.rightHold).toBe(6n);
    expect(account.state.jNonce).toBe(1);
  });

  test('bilaterally finalized AccountSettled claim deletes the submitted optional workspace', async () => {
    const env = createEmptyEnv('settlement-transition-finalized-claim-delete');
    const jurisdiction = makeJurisdiction('settlement-transition', 31337, 'a1', 'b2');
    const signer = addr('37');
    const state = makeState(LEFT, signer, jurisdiction, RIGHT);
    addReplica(env, state, signer);
    installProofStack(env, state);
    expect((await upsertOnState(state, RIGHT, {
      revision: 1,
      ops: [{ type: 'r2r', tokenId: 1, amount: 4n }],
      executorIsLeft: false,
    })).ok).toBe(true);
    const account = writableAccount(state, RIGHT);
    account.state.settlementWorkspace!.leftHanko = '0x1234';
    account.state.settlementWorkspace!.status = 'submitted';
    account.state.settlementWorkspace!.nonceAtSign = 1;
    account.state.settlementWorkspace!.settlementHash = `0x${'70'.repeat(32)}`;
    account.state.settlementWorkspace!.postSettlementDisputeProof = {
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
    const firstSession = createAccountJClaimSession(getAccountJClaimNodeStore(env));
    const leftClaim = prepareAccountJClaimTx(account.state, rawClaim, domain, firstSession);
    const claimContext = createAccountConsensusContext(env);
    expect((await applyAccountTxToMutableReplica(
      account,
      leftClaim,
      true,
      2_000,
      0,
      false,
      claimContext,
      firstSession,
    )).ok).toBe(true);
    cacheCommittedAccountJClaimNodeChanges(env, firstSession.changes());
    const secondSession = createAccountJClaimSession(getAccountJClaimNodeStore(env));
    const rightClaim = prepareAccountJClaimTx(account.state, rawClaim, domain, secondSession);
    expect((await applyAccountTxToMutableReplica(
      account,
      rightClaim,
      false,
      2_001,
      0,
      false,
      claimContext,
      secondSession,
    )).ok).toBe(true);

    expect(account.state.lastFinalizedJHeight).toBe(7);
    expect(account.state.leftPendingJClaims.count).toBe(0n);
    expect(account.state.rightPendingJClaims.count).toBe(0n);
    expect(account.state.settlementWorkspace).toBeUndefined();
  });

  test('older AccountSettled nonce retains a newer signed workspace and does not activate its proof', async () => {
    const account = await signedWorkspaceAccount(10);
    const workspaceHash = account.state.settlementWorkspace!.workspaceHash;

    applyFinalizedAccountJEvents(account, RIGHT, [accountSettledEvent(9)], TEST_DELTA_TRANSFORMER);

    expect(account.state.jNonce).toBe(9);
    expect(account.state.settlementWorkspace?.workspaceHash).toBe(workspaceHash);
    expect(account.currentDisputeHash).toBeUndefined();
    expect(account.currentDisputeProofHanko).toBeUndefined();
  });

  test('R2C AccountSettled nonce zero retains a signed workspace for nonce one', async () => {
    const account = await signedWorkspaceAccount(1);
    const workspaceHash = account.state.settlementWorkspace!.workspaceHash;

    applyFinalizedAccountJEvents(account, RIGHT, [accountSettledEvent(0)], TEST_DELTA_TRANSFORMER);

    expect(account.state.jNonce).toBe(0);
    expect(account.state.settlementWorkspace?.workspaceHash).toBe(workspaceHash);
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

    expect(account.state.jNonce).toBe(0);
    expect(account.state.deltas.get(1)?.collateral).toBe(0n);
    expect(account.state.settlementWorkspace).toBeDefined();
  });

  test('AccountSettled finality rejects out-of-domain tokens before mutation', () => {
    const account = makeAccount(LEFT, RIGHT);
    const event = accountSettledEvent(1);
    event.data.tokenId = TOKENS.MAX_TOKEN_ID + 1;
    event.data.collateral = '99';

    expect(() => applyFinalizedAccountJEvents(account, RIGHT, [event], TEST_DELTA_TRANSFORMER))
      .toThrow('SETTLEMENT_TOKEN_INVALID:AccountSettled');
    expect(account.state.jNonce).toBe(0);
    expect(account.state.deltas.has(event.data.tokenId)).toBe(false);
  });

  test('AccountSettled finality rejects cumulative token-row overflow atomically', () => {
    const account = makeAccount(LEFT, RIGHT);
    for (let tokenId = 2; tokenId <= LIMITS.MAX_ACCOUNT_TOKEN_ROWS; tokenId += 1) {
      putDelta(account, createDefaultDelta(tokenId));
    }
    const event = accountSettledEvent(1);
    event.data.tokenId = TOKENS.MAX_TOKEN_ID;
    event.data.collateral = '99';

    expect(() => applyFinalizedAccountJEvents(account, RIGHT, [event], TEST_DELTA_TRANSFORMER))
      .toThrow('ACCOUNT_DELTA_ROW_LIMIT_EXCEEDED:insert');
    expect(account.state.jNonce).toBe(0);
    expect(account.state.deltas.size).toBe(LIMITS.MAX_ACCOUNT_TOKEN_ROWS);
    expect(account.state.deltas.has(TOKENS.MAX_TOKEN_ID)).toBe(false);
    expect(account.state.deltas.get(1)?.collateral).toBe(0n);
  });

  test('matching AccountSettled nonce clears the workspace and activates its next proof', async () => {
    const account = await signedWorkspaceAccount(10);

    applyFinalizedAccountJEvents(account, RIGHT, [accountSettledEvent(10)], TEST_DELTA_TRANSFORMER);

    expect(account.state.jNonce).toBe(10);
    expect(account.state.settlementWorkspace).toBeUndefined();
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

    expect(account.state.jNonce).toBe(2);
    expect(account.state.settlementWorkspace).toBeUndefined();
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
    account.state.settlementWorkspace!.postSettlementDisputeProof!.nonce = 12;

    expect(() => applyFinalizedAccountJEvents(account, RIGHT, [accountSettledEvent(10)], TEST_DELTA_TRANSFORMER))
      .toThrow('POST_SETTLEMENT_PROOF_NONCE_MISMATCH');

    expect(account.state.settlementWorkspace).toBeDefined();
    expect(account.currentDisputeHash).toBeUndefined();
  });

  test('a signed workspace without its exact settlement nonce fails loud at finality', async () => {
    const account = await signedWorkspaceAccount(10);
    delete account.state.settlementWorkspace!.nonceAtSign;

    expect(() => applyFinalizedAccountJEvents(account, RIGHT, [accountSettledEvent(10)], TEST_DELTA_TRANSFORMER))
      .toThrow('SETTLEMENT_SIGNED_NONCE_MISSING');

    expect(account.state.settlementWorkspace).toBeDefined();
    expect(account.currentDisputeHash).toBeUndefined();
  });

  test('AccountSettled finality clears an unsigned workspace whose holds were based on old state', async () => {
    const account = makeAccount(LEFT, RIGHT);
    expect((await upsert(account, {
      revision: 1,
      ops: [{ type: 'r2r', tokenId: 1, amount: 4n }],
      executorIsLeft: false,
    })).ok).toBe(true);
    expect(account.state.deltas.get(1)?.leftHold).toBe(4n);

    applyFinalizedAccountJEvents(account, RIGHT, [accountSettledEvent(1)], TEST_DELTA_TRANSFORMER);

    expect(account.state.jNonce).toBe(1);
    expect(account.state.settlementWorkspace).toBeUndefined();
    expect(account.state.deltas.get(1)?.leftHold).toBe(0n);
  });

  test('R2C AccountSettled nonce zero clears an unsigned workspace with stale capacity holds', async () => {
    const account = makeAccount(LEFT, RIGHT);
    expect((await upsert(account, {
      revision: 1,
      ops: [{ type: 'r2r', tokenId: 1, amount: 4n }],
      executorIsLeft: false,
    })).ok).toBe(true);
    expect(account.state.jNonce).toBe(0);
    expect(account.state.deltas.get(1)?.leftHold).toBe(4n);

    applyFinalizedAccountJEvents(account, RIGHT, [accountSettledEvent(0)], TEST_DELTA_TRANSFORMER);

    expect(account.state.jNonce).toBe(0);
    expect(account.state.settlementWorkspace).toBeUndefined();
    expect(account.state.deltas.get(1)?.leftHold).toBe(0n);
  });

  test('multi-token AccountSettled events sharing one nonce finalize as one settlement', async () => {
    const account = makeAccount(LEFT, RIGHT);
    const token2 = createDefaultDelta(2);
    token2.leftCreditLimit = 100n;
    token2.rightCreditLimit = 100n;
    putDelta(account, token2);
    expect((await upsert(account, {
      revision: 1,
      ops: [
        { type: 'r2r', tokenId: 1, amount: 4n },
        { type: 'r2r', tokenId: 2, amount: 2n },
      ],
      executorIsLeft: false,
    })).ok).toBe(true);
    account.state.settlementWorkspace!.leftHanko = '0x1234';
    account.state.settlementWorkspace!.rightHanko = '0x5678';
    account.state.settlementWorkspace!.nonceAtSign = 10;
    account.state.settlementWorkspace!.postSettlementDisputeProof = {
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

    expect(account.state.jNonce).toBe(10);
    expect(account.state.settlementWorkspace).toBeUndefined();
    expect(account.state.deltas.get(1)?.leftHold).toBe(0n);
    expect(account.state.deltas.get(2)?.leftHold).toBe(0n);
    expect(account.state.deltas.get(2)?.collateral).toBe(25n);
    expect(account.state.deltas.get(2)?.ondelta).toBe(7n);
    expect(account.currentDisputeHash).toBe(`0x${'84'.repeat(32)}`);
  });

  test('newer AccountSettled nonce clears a stale workspace without activating its post proof', async () => {
    const account = await signedWorkspaceAccount(10);

    applyFinalizedAccountJEvents(account, RIGHT, [accountSettledEvent(12)], TEST_DELTA_TRANSFORMER);

    expect(account.state.jNonce).toBe(12);
    expect(account.state.settlementWorkspace).toBeUndefined();
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

    expect(account.state.jNonce).toBe(12);
    expect(account.state.settlementWorkspace).toBeUndefined();
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
    expect((await upsertOnState(state, RIGHT, {
      revision: 1,
      ops: [{ type: 'r2r', tokenId: 1, amount: 4n }],
      executorIsLeft: false,
    })).ok).toBe(true);
    const account = writableAccount(state, RIGHT);
    const workspaceHash = account.state.settlementWorkspace!.workspaceHash;
    account.state.jNonce = 2;
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
    expect(resultAccount.state.settlementWorkspace?.workspaceHash).toBe(workspaceHash);
    expect(resultAccount.state.deltas.get(1)?.leftHold).toBe(4n);
  });

  test('restored Account state continues the same exact workspace hash/revision chain', async () => {
    const live = makeAccount(LEFT, RIGHT);
    const first = await upsert(live, {
      revision: 1,
      ops: [{ type: 'r2r', tokenId: 1, amount: 4n }],
      executorIsLeft: false,
    });
    expect(first.ok).toBe(true);
    const restored = forkAccountReplicaShell(live);
    const previousWorkspaceHash = live.state.settlementWorkspace!.workspaceHash;
    const update = transition({
      kind: 'upsert',
      revision: 2,
      previousWorkspaceHash,
      ops: [{ type: 'r2r', tokenId: 1, amount: 2n }],
      executorIsLeft: true,
      memo: 'after restore',
    });

    const [liveResult, restoredResult] = await Promise.all([
      applyAccountTxToMutableReplica(live, update, true, 2_000),
      applyAccountTxToMutableReplica(restored, update, true, 2_000),
    ]);

    expect(liveResult.ok).toBe(true);
    expect(restoredResult.ok).toBe(true);
    expect(restored.state.settlementWorkspace).toEqual(live.state.settlementWorkspace);
    expect(restored.state.deltas.get(1)?.leftHold).toBe(live.state.deltas.get(1)?.leftHold);
  });

  test('Account cloning isolates nested post-settlement proof signatures', async () => {
    const account = makeAccount(LEFT, RIGHT);
    expect((await upsert(account, {
      revision: 1,
      ops: [{ type: 'r2r', tokenId: 1, amount: 4n }],
      executorIsLeft: false,
    })).ok).toBe(true);
    account.state.settlementWorkspace!.postSettlementDisputeProof = {
      disputeHash: `0x${'61'.repeat(32)}`,
      proofBodyHash: `0x${'62'.repeat(32)}`,
      nonce: 2,
    };

    const clone = forkAccountReplicaShell(account);
    clone.state.settlementWorkspace!.postSettlementDisputeProof!.leftHanko = '0x1234';

    expect(account.state.settlementWorkspace?.postSettlementDisputeProof?.leftHanko).toBeUndefined();
    expect(clone.state.settlementWorkspace?.postSettlementDisputeProof?.leftHanko).toBe('0x1234');
  });
  /**
   * Wiring guard, not a behavioural one: it asserts the two settlement Hanko
   * call sites pass opposite board authority, matching the jurisdiction.
   * Cooperative settlement moves fresh funds and is current-board-only on-chain
   * (Account.sol:894 / Account.sol:790 use verifyCurrentHankoSignature); the
   * post-settlement dispute proof is historical evidence and Account.sol:1063
   * grants it the full previous-board grace. Accepting a rotated-out board on
   * the money path would advance the bilateral state off-chain on a signature
   * the jurisdiction rejects.
   */
  test('settlement seal is current-board-only while its dispute proof keeps board grace', () => {
    const repoRoot = process.cwd();
    const accountSeal = readFileSync(
      join(repoRoot, 'core/account/tx/handlers/settlement/transition.ts'),
      'utf8',
    );
    const entitySeal = readFileSync(
      join(repoRoot, 'core/entity/tx/handlers/payments/settle.ts'),
      'utf8',
    );

    const postProofCall = accountSeal.indexOf('prepared.expectedDisputeHash');
    const settlementCall = accountSeal.indexOf('prepared.expectedSettlementHash');
    expect(postProofCall).toBeGreaterThanOrEqual(0);
    expect(settlementCall).toBeGreaterThan(postProofCall);
    expect(accountSeal.slice(postProofCall, settlementCall)).toContain('allowPreviousBoard: true');
    expect(accountSeal.slice(settlementCall)).toContain('allowPreviousBoard: false');

    // The Entity helper is shared by both, so the split lives in its argument.
    expect(entitySeal).toContain("allowPreviousBoard = authority === 'historicalEvidence'");
    const nonExecutor = entitySeal.indexOf("'SETTLEMENT_NONEXECUTOR',");
    const postLeft = entitySeal.indexOf("'POST_SETTLEMENT_LEFT',");
    const postRight = entitySeal.indexOf("'POST_SETTLEMENT_RIGHT',");
    expect(nonExecutor).toBeGreaterThanOrEqual(0);
    expect(entitySeal.slice(nonExecutor, nonExecutor + 80)).toContain("'freshMovement'");
    expect(entitySeal.slice(postLeft, postLeft + 80)).toContain("'historicalEvidence'");
    expect(entitySeal.slice(postRight, postRight + 80)).toContain("'historicalEvidence'");
  });
});
