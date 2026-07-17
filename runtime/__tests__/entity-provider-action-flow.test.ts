import { describe, expect, test } from 'bun:test';

import {
  deriveSignerAddressSync,
  deriveSignerKeySync,
  registerSignerKey,
  signAccountFrame,
} from '../account/crypto';
import {
  assertEntityProviderActionJTxBinding,
  recomputeEntityProviderActionHash,
} from '../entity/entity-provider-action';
import { buildCollectiveEntityProposalTx } from '../entity/authorization';
import { buildSignedEntityCommand } from '../entity/command';
import { signedEntityCommandTx } from '../entity/command-codec';
import { applyEntityFrame, applyEntityInput } from '../entity/consensus';
import { applyEntityTx } from '../entity/tx/apply';
import { handleEntityProviderTransfer } from '../entity/tx/handlers/entity-provider-action';
import {
  applyEntityProviderActionCancelled,
  applyEntityProviderActionExecuted,
} from '../entity/tx/j-events-entity-provider-action';
import { encodeBoard, hashBoard } from '../entity/factory';
import { buildQuorumHanko, verifyHankoForHash } from '../hanko/signing';
import { buildSingleSignerHanko } from '../hanko/batch';
import {
  applyRetryEntityProviderActionRuntimeTx,
} from '../machine/entity-provider-action-submit-state';
import {
  assertEntityProviderActionRuntimeTxAuthorized,
  markLocalEntityProviderActionRuntimeTx,
} from '../machine/entity-provider-action-submit-auth';
import {
  applyRecordEntityProviderActionResultRuntimeTx,
  makeEntityProviderActionResultRuntimeTx,
} from '../machine/entity-provider-action-submit-result';
import {
  collectDueEntityProviderActionRuntimeTxs,
  getNextEntityProviderActionRetryTimestamp,
} from '../machine/entity-provider-action-submit-scheduler';
import {
  registerPendingCommittedJOutbox,
  splitJOutboxForDurableSubmit,
} from '../machine/j-submit-state';
import { createEmptyEnv } from '../runtime';
import { createJAdapter } from '../jadapter';
import {
  applyCertifiedBoardRegistryEvent,
  cacheCertifiedBoardNodes,
  getCertifiedBoardNodeStore,
  resolveObserverCertifiedBoardRecord,
} from '../jurisdiction/board-registry';
import {
  buildCanonicalEntityReplicaSnapshot,
  buildDurableRuntimeMachineSnapshot,
  restoreDurableRuntimeSnapshot,
} from '../wal/snapshot';
import { hydrateEntityStateFromStorage } from '../storage/hydration';
import { projectEntityCoreDoc } from '../storage/projections';
import type { ConsensusConfig, EntityReplica, EntityState, EntityTx, Env, JTx } from '../types';
import { applyJEventRange } from './helpers/j-history';

const address = (byte: string): string => `0x${byte.repeat(20)}`;
const numberedEntityId = (value: bigint): string => `0x${value.toString(16).padStart(64, '0')}`;
const blockHash = (byte: string): string => `0x${byte.repeat(32)}`;

const baseState = (entityId: string, config: ConsensusConfig, timestamp: number): EntityState => ({
  entityId,
  height: 0,
  timestamp,
  nonces: new Map(),
  messages: [],
  proposals: new Map(),
  config,
  reserves: new Map(),
  accounts: new Map(),
  lastFinalizedJHeight: 0,
  jBlockChain: [],
  entityEncPubKey: `0x${'01'.repeat(32)}`,
  entityEncPrivKey: `0x${'02'.repeat(32)}`,
  profile: { name: '', isHub: false, avatar: '', bio: '', website: '' },
  htlcRoutes: new Map(),
  htlcFeesEarned: 0n,
  lockBook: new Map(),
});

const installCertifiedBoardAuthority = (env: Env, state: EntityState): void => {
  const jurisdiction = state.config.jurisdiction;
  if (!jurisdiction) throw new Error('TEST_CERTIFIED_BOARD_JURISDICTION_MISSING');
  const boardHash = hashBoard(encodeBoard(state.config, env));
  const events = [
    {
      type: 'FoundationBootstrapped' as const,
      data: { recipient: env.runtimeId, boardHash, controlTokenId: '2', dividendTokenId: '3' },
      blockNumber: 1,
      blockHash: blockHash('11'),
      transactionHash: blockHash('21'),
      logIndex: 0,
    },
    {
      type: 'EntityRegistered' as const,
      data: { entityId: state.entityId, entityNumber: BigInt(state.entityId).toString(), boardHash },
      blockNumber: 2,
      blockHash: blockHash('12'),
      transactionHash: blockHash('22'),
      logIndex: 0,
    },
  ];
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

const applyCertifiedBoardEvent = (
  env: Env,
  state: EntityState,
  event: Parameters<typeof applyCertifiedBoardRegistryEvent>[3],
): void => {
  const jurisdiction = state.config.jurisdiction;
  if (!jurisdiction) throw new Error('TEST_CERTIFIED_BOARD_JURISDICTION_MISSING');
  const applied = applyCertifiedBoardRegistryEvent(
    state.certifiedBoardState,
    getCertifiedBoardNodeStore(env),
    jurisdiction,
    event,
  );
  cacheCertifiedBoardNodes(env, applied.newNodes);
  state.certifiedBoardState = applied.state;
};

const setup = (label = 'single') => {
  const env = createEmptyEnv(`entity-provider-action-flow:${label}`);
  env.scenarioMode = true;
  env.timestamp = 1_000;
  const signerId = deriveSignerAddressSync(env.runtimeSeed!, 'validator').toLowerCase();
  registerSignerKey(env, signerId, deriveSignerKeySync(env.runtimeSeed!, 'validator'));
  env.runtimeId = signerId;
  const config: ConsensusConfig = {
    mode: 'proposer-based',
    threshold: 1n,
    validators: [signerId],
    shares: { [signerId]: 1n },
    jurisdiction: {
      address: address('a1'),
      name: 'EntityProviderActions',
      chainId: 31_337,
      depositoryAddress: address('a2'),
      entityProviderAddress: address('a3'),
    },
  };
  const state = baseState(numberedEntityId(2n), config, env.timestamp);
  installCertifiedBoardAuthority(env, state);
  const replica: EntityReplica = { entityId: state.entityId, signerId, state, mempool: [], isProposer: true };
  env.eReplicas.set(`${state.entityId}:${signerId}`, replica);
  env.jReplicas.set('EntityProviderActions', {
    name: 'EntityProviderActions',
    blockNumber: 0n,
    stateRoot: null,
    mempool: [],
    blockDelayMs: 0,
    lastBlockTimestamp: 0,
    chainId: 31_337,
    position: { x: 0, y: 0, z: 0 },
    depositoryAddress: address('a2'),
    entityProviderAddress: address('a3'),
    contracts: { depository: address('a2'), entityProvider: address('a3') },
  });
  return { env, state, signerId, replica };
};

const transferTx = (amount = 11n): Extract<EntityTx, { type: 'entityProviderTransfer' }> => ({
  type: 'entityProviderTransfer',
  data: { to: address('b1'), tokenId: 7n, amount },
});

const requireActionJTx = (jTx: JTx | undefined) => {
  if (
    jTx?.type !== 'entityProviderTransfer' &&
    jTx?.type !== 'entityProviderReleaseControlShares' &&
    jTx?.type !== 'entityProviderCancelAction'
  ) {
    throw new Error(`TEST_ENTITY_PROVIDER_ACTION_JTX_MISSING:${jTx?.type ?? 'none'}`);
  }
  return jTx;
};

const buildPending = async (fixture: ReturnType<typeof setup>) => {
  const result = await applyEntityTx(fixture.env, fixture.state, transferTx());
  if (result.skippedError) throw result.skippedError;
  const jTx = requireActionJTx(result.jOutputs[0]?.jTxs[0]);
  fixture.replica.state = result.newState;
  const pending = result.newState.entityProviderActionState?.pending;
  if (!pending) throw new Error('TEST_ENTITY_PROVIDER_ACTION_PENDING_MISSING');
  fixture.replica.hankoWitness = new Map([[pending.actionHash, {
    hanko: `0x${'12'.repeat(65)}`,
    type: 'entityProviderAction',
    entityHeight: 1,
    createdAt: fixture.env.timestamp,
  }]]);
  return { result, jTx, pending };
};

describe('EntityProvider action flow', () => {
  test('builds exact trusted-domain transfer and release intents', async () => {
    const fixture = setup('exact-domain');
    const transfer = await buildPending(fixture);
    expect(transfer.result.hashesToSign).toEqual([expect.objectContaining({
      hash: transfer.pending.actionHash,
      type: 'entityProviderAction',
    })]);
    expect(transfer.pending).toMatchObject({
      entityId: fixture.state.entityId,
      chainId: 31_337n,
      entityProviderAddress: address('a3'),
      actionNonce: 1n,
      generation: 1,
    });
    expect(recomputeEntityProviderActionHash(transfer.pending)).toBe(transfer.pending.actionHash);

    const finalized = structuredClone(transfer.result.newState);
    applyEntityProviderActionExecuted(finalized, {
      entityId: finalized.entityId,
      actionNonce: 1n,
      actionHash: transfer.pending.actionHash,
      actionKind: 0,
    }, 10);
    const release = await applyEntityTx(fixture.env, finalized, {
      type: 'entityProviderReleaseControlShares',
      data: { controlAmount: 2n, dividendAmount: 3n, purpose: 'Series A' },
    });
    const releaseIntent = requireActionJTx(release.jOutputs[0]?.jTxs[0]).data.intent;
    expect(releaseIntent.payload).toEqual({
      kind: 'releaseControlShares',
      release: {
        depositoryAddress: address('a2'),
        controlAmount: 2n,
        dividendAmount: 3n,
        purpose: 'Series A',
      },
    });
  });

  test('builds an exact domain-bound cancellation for the current pending nonce', async () => {
    const fixture = setup('cancel-intent');
    const original = await buildPending(fixture);
    const cancellation = await applyEntityTx(
      fixture.env,
      original.result.newState,
      {
        type: 'entityProviderCancelAction',
        data: { actionHash: original.pending.actionHash },
      } as never,
    );
    expect(cancellation.skippedError).toBeUndefined();
    const cancelJTx = cancellation.jOutputs[0]?.jTxs[0] as unknown as {
      type?: string;
      data?: { intent?: { actionHash?: string; actionNonce?: bigint; payload?: unknown } };
    };
    expect(cancelJTx.type).toBe('entityProviderCancelAction');
    expect(cancelJTx.data?.intent).toMatchObject({
      actionNonce: original.pending.actionNonce,
      payload: {
        kind: 'cancelPendingAction',
        cancel: {
          cancelledActionHash: original.pending.actionHash,
          cancelledActionKind: 0,
        },
      },
    });
    expect(cancelJTx.data?.intent?.actionHash).toMatch(/^0x[0-9a-f]{64}$/);
    expect(cancelJTx.data?.intent?.actionHash).not.toBe(original.pending.actionHash);
    expect(cancellation.hashesToSign).toEqual([expect.objectContaining({
      hash: cancelJTx.data?.intent?.actionHash,
      type: 'entityProviderAction',
    })]);
    const cancelTx = {
      type: 'entityProviderCancelAction' as const,
      data: { actionHash: original.pending.actionHash },
    };
    expect(() => buildSignedEntityCommand(
      fixture.env,
      original.result.newState,
      fixture.signerId,
      [cancelTx],
    )).toThrow('ENTITY_COMMAND_COLLECTIVE_ACTION_REQUIRES_PROPOSAL:entityProviderCancelAction');
    const cancelProposal = buildCollectiveEntityProposalTx(fixture.signerId, [cancelTx]);
    const cancelCommand = buildSignedEntityCommand(
      fixture.env,
      original.result.newState,
      fixture.signerId,
      [cancelProposal],
    );
    const quorumAuthorized = await applyEntityFrame(
      fixture.env,
      original.result.newState,
      [signedEntityCommandTx(cancelCommand)],
      fixture.env.timestamp + 1,
    );
    expect(quorumAuthorized.newState.entityProviderActionState?.pending?.actionHash)
      .toBe(cancelJTx.data?.intent?.actionHash);
    const cancelPending = cancellation.newState.entityProviderActionState?.pending;
    if (!cancelPending || cancelPending.payload.kind !== 'cancelPendingAction') {
      throw new Error('TEST_ENTITY_PROVIDER_CANCEL_PENDING_MISSING');
    }

    const executeWins = structuredClone(cancellation.newState);
    applyEntityProviderActionExecuted(executeWins, {
      entityId: executeWins.entityId,
      actionNonce: original.pending.actionNonce,
      actionHash: original.pending.actionHash,
      actionKind: 0,
    }, 10);
    expect(executeWins.entityProviderActionState).toEqual({
      version: 1,
      confirmedNonce: original.pending.actionNonce,
      generation: 2,
    });

    const cancelWins = structuredClone(cancellation.newState);
    applyEntityProviderActionCancelled(cancelWins, {
      entityId: cancelWins.entityId,
      actionNonce: original.pending.actionNonce,
      cancelledActionHash: original.pending.actionHash,
      cancelledActionKind: 0,
      cancelHash: cancelPending.actionHash,
    }, 11);
    expect(cancelWins.entityProviderActionState).toEqual({
      version: 1,
      confirmedNonce: original.pending.actionNonce,
      generation: 2,
    });

    const mismatched = structuredClone(cancellation.newState);
    expect(() => applyEntityProviderActionCancelled(mismatched, {
      entityId: mismatched.entityId,
      actionNonce: original.pending.actionNonce,
      cancelledActionHash: original.pending.actionHash,
      cancelledActionKind: 0,
      cancelHash: `0x${'ff'.repeat(32)}`,
    }, 12)).toThrow('ENTITY_PROVIDER_CANCEL_RECEIPT_MISMATCH');
    expect(mismatched.entityProviderActionState?.pending?.actionHash).toBe(cancelPending.actionHash);
  });

  test('rejects payload authority over chain, contracts, entity, JTx variant, and payload shape', async () => {
    const fixture = setup('binding');
    const { jTx } = await buildPending(fixture);
    const trusted = {
      chainId: 31_337,
      entityProviderAddress: address('a3'),
      depositoryAddress: address('a2'),
    };
    expect(() => assertEntityProviderActionJTxBinding(jTx, trusted)).not.toThrow();
    const wrongEntity = structuredClone(jTx);
    wrongEntity.entityId = numberedEntityId(3n);
    expect(() => assertEntityProviderActionJTxBinding(wrongEntity, trusted))
      .toThrow('ENTITY_PROVIDER_ACTION_INTENT_INVALID');
    const wrongVariant = { ...structuredClone(jTx), type: 'entityProviderReleaseControlShares' as const };
    expect(() => assertEntityProviderActionJTxBinding(wrongVariant, trusted))
      .toThrow('ENTITY_PROVIDER_ACTION_KIND_MISMATCH');
    expect(() => assertEntityProviderActionJTxBinding(jTx, { ...trusted, chainId: 1 }))
      .toThrow('ENTITY_PROVIDER_ACTION_INTENT_INVALID');
    expect(() => assertEntityProviderActionJTxBinding(jTx, {
      ...trusted,
      entityProviderAddress: address('ff'),
    })).toThrow('ENTITY_PROVIDER_ACTION_INTENT_INVALID');

    const malformed = structuredClone(jTx);
    if (malformed.data.intent.payload.kind !== 'entityTransferTokens') throw new Error('TEST_TRANSFER_PAYLOAD_MISSING');
    (malformed.data.intent.payload.transfer as { amount: bigint }).amount = 0n;
    expect(() => assertEntityProviderActionJTxBinding(malformed, trusted))
      .toThrow('ENTITY_PROVIDER_ACTION_AMOUNT_INVALID');
  });

  test('rejects uint256 nonce exhaustion and safe-integer generation exhaustion before increment', () => {
    const fixture = setup('exhaustion');
    fixture.state.entityProviderActionState = {
      version: 1,
      confirmedNonce: (1n << 256n) - 1n,
      generation: 1,
    };
    expect(() => handleEntityProviderTransfer(fixture.state, transferTx(), fixture.env))
      .toThrow('ENTITY_PROVIDER_ACTION_NONCE_EXHAUSTED');
    fixture.state.entityProviderActionState = {
      version: 1,
      confirmedNonce: 1n,
      generation: Number.MAX_SAFE_INTEGER,
    };
    expect(() => handleEntityProviderTransfer(fixture.state, transferTx(), fixture.env))
      .toThrow('ENTITY_PROVIDER_ACTION_GENERATION_EXHAUSTED');
  });

  test('allows the action only through signed proposal quorum, never a direct board-signer command', async () => {
    const fixture = setup('collective-only');
    expect(() => buildSignedEntityCommand(
      fixture.env,
      fixture.state,
      fixture.signerId,
      [transferTx()],
    )).toThrow('ENTITY_COMMAND_COLLECTIVE_ACTION_REQUIRES_PROPOSAL:entityProviderTransfer');
    const proposal = buildCollectiveEntityProposalTx(fixture.signerId, [transferTx()]);
    const command = buildSignedEntityCommand(
      fixture.env,
      fixture.state,
      fixture.signerId,
      [proposal],
    );
    const applied = await applyEntityFrame(
      fixture.env,
      fixture.state,
      [signedEntityCommandTx(command)],
      fixture.env.timestamp + 1,
    );
    expect(applied.newState.entityProviderActionState?.pending?.payload.kind)
      .toBe('entityTransferTokens');
    expect(applied.collectedHashes.some(({ type }) => type === 'entityProviderAction')).toBe(true);
    expect(Array.from(applied.newState.proposals.values())[0]?.status).toBe('executed');
  });

  test('clears pending only for the exact canonical nonce/hash/kind receipt', async () => {
    const fixture = setup('receipt');
    const { result, pending } = await buildPending(fixture);
    for (const bad of [
      { actionNonce: 2n, actionHash: pending.actionHash, actionKind: 0 as const },
      { actionNonce: 1n, actionHash: `0x${'ff'.repeat(32)}`, actionKind: 0 as const },
      { actionNonce: 1n, actionHash: pending.actionHash, actionKind: 1 as const },
    ]) {
      const state = structuredClone(result.newState);
      expect(() => applyEntityProviderActionExecuted(state, {
        entityId: state.entityId,
        ...bad,
      }, 10)).toThrow(/ENTITY_PROVIDER_ACTION_(EVENT_NONCE_MISMATCH|RECEIPT_MISMATCH)/);
      expect(state.entityProviderActionState?.pending?.actionHash).toBe(pending.actionHash);
    }
    const state = structuredClone(result.newState);
    applyEntityProviderActionExecuted(state, {
      entityId: state.entityId,
      actionNonce: 1n,
      actionHash: pending.actionHash,
      actionKind: 0,
    }, 10);
    expect(state.entityProviderActionState).toEqual({ version: 1, confirmedNonce: 1n, generation: 1 });
  });

  test('reconciles historical on-chain action nonces in strict linked order without local pending', () => {
    const fixture = setup('historical-reconcile');
    const hash1 = `0x${'11'.repeat(32)}`;
    const hash2 = `0x${'22'.repeat(32)}`;
    applyEntityProviderActionExecuted(fixture.state, {
      entityId: fixture.state.entityId,
      actionNonce: 1n,
      actionHash: hash1,
      actionKind: 0,
    }, 11);
    applyEntityProviderActionExecuted(fixture.state, {
      entityId: fixture.state.entityId,
      actionNonce: 2n,
      actionHash: hash2,
      actionKind: 1,
    }, 12);
    expect(fixture.state.entityProviderActionState?.confirmedNonce).toBe(2n);
    expect(() => applyEntityProviderActionExecuted(fixture.state, {
      entityId: fixture.state.entityId,
      actionNonce: 4n,
      actionHash: `0x${'44'.repeat(32)}`,
      actionKind: 0,
    }, 14)).toThrow('ENTITY_PROVIDER_ACTION_EVENT_NONCE_MISMATCH');
  });

  test('materializes only a quorum-witnessed action as a durable post-commit attempt', async () => {
    const fixture = setup('durable-attempt');
    const { jTx, pending } = await buildPending(fixture);
    jTx.data.hankoSignature = fixture.replica.hankoWitness?.get(pending.actionHash)?.hanko;
    const split = splitJOutboxForDurableSubmit([{
      jurisdictionName: 'EntityProviderActions',
      jTxs: [jTx],
    }]);
    expect(split.immediate).toEqual([]);
    expect(split.durable).toEqual([]);
    expect(split.retries.map((tx) => tx.type)).toEqual(['retryEntityProviderAction']);

    const attemptOutbox = applyRetryEntityProviderActionRuntimeTx(
      fixture.env,
      split.retries[0] as Extract<(typeof split.retries)[number], { type: 'retryEntityProviderAction' }>,
    );
    expect(attemptOutbox[0]?.jTxs[0]).toMatchObject({
      type: 'entityProviderTransfer',
      data: {
        signerId: fixture.signerId,
        intent: { actionHash: pending.actionHash },
        runtimeSubmitAttempt: { attemptNumber: 1, generation: 1 },
      },
    });
    registerPendingCommittedJOutbox(fixture.env, attemptOutbox);
    expect(fixture.env.runtimeState?.pendingCommittedJOutbox).toHaveLength(1);
    expect(collectDueEntityProviderActionRuntimeTxs(fixture.env, fixture.env.timestamp)).toEqual([]);
  });

  test('BoardActivated expires pending only for this Entity and preserves nonce plus generation', async () => {
    const fixture = setup('board-activation-pending-scope');
    const { pending } = await buildPending(fixture);
    const foreignEntityId = numberedEntityId(3n);
    const foreignBoardHash = blockHash('31');
    applyCertifiedBoardEvent(fixture.env, fixture.replica.state, {
      type: 'EntityRegistered',
      data: {
        entityId: foreignEntityId,
        entityNumber: '3',
        boardHash: foreignBoardHash,
      },
      blockNumber: 2,
      blockHash: blockHash('12'),
      transactionHash: blockHash('23'),
      logIndex: 1,
    });
    const foreignActivation = {
      type: 'BoardActivated' as const,
      data: {
        entityId: foreignEntityId,
        previousBoardHash: foreignBoardHash,
        newBoardHash: blockHash('32'),
        previousBoardValidUntil: '1700604800',
      },
      blockNumber: 3,
      blockHash: blockHash('13'),
      transactionHash: blockHash('33'),
      logIndex: 0,
    };
    const afterForeign = await applyJEventRange(fixture.replica.state, {
      from: fixture.signerId,
      jurisdictionRef: '',
      event: foreignActivation,
      observedAt: 3,
      blockNumber: 3,
      blockHash: foreignActivation.blockHash,
      transactionHash: foreignActivation.transactionHash,
    }, fixture.env);
    expect(afterForeign.newState.entityProviderActionState?.pending?.actionHash).toBe(pending.actionHash);

    const currentSelf = resolveObserverCertifiedBoardRecord(
      afterForeign.newState,
      getCertifiedBoardNodeStore(fixture.env),
      fixture.replica.entityId,
    );
    if (!currentSelf) throw new Error('TEST_SELF_CERTIFIED_BOARD_RECORD_MISSING');
    const selfActivation = {
      type: 'BoardActivated' as const,
      data: {
        entityId: fixture.replica.entityId,
        previousBoardHash: currentSelf.boardHash,
        newBoardHash: blockHash('34'),
        previousBoardValidUntil: '1700604800',
      },
      blockNumber: 4,
      blockHash: blockHash('14'),
      transactionHash: blockHash('34'),
      logIndex: 0,
    };
    const afterSelf = await applyJEventRange(afterForeign.newState, {
      from: fixture.signerId,
      jurisdictionRef: '',
      event: selfActivation,
      observedAt: 4,
      blockNumber: 4,
      blockHash: selfActivation.blockHash,
      transactionHash: selfActivation.transactionHash,
    }, fixture.env);
    expect(afterSelf.newState.entityProviderActionState).toEqual({
      version: 1,
      confirmedNonce: 0n,
      generation: 1,
    });
  });

  test('retry rejects a pending action from an older certified board epoch', async () => {
    const fixture = setup('stale-board-epoch-retry');
    await buildPending(fixture);
    const current = resolveObserverCertifiedBoardRecord(
      fixture.replica.state,
      getCertifiedBoardNodeStore(fixture.env),
      fixture.replica.entityId,
    );
    if (!current) throw new Error('TEST_CURRENT_CERTIFIED_BOARD_RECORD_MISSING');
    applyCertifiedBoardEvent(fixture.env, fixture.replica.state, {
      type: 'BoardActivated',
      data: {
        entityId: fixture.replica.entityId,
        previousBoardHash: current.boardHash,
        newBoardHash: blockHash('35'),
        previousBoardValidUntil: '1700604800',
      },
      blockNumber: 3,
      blockHash: blockHash('15'),
      transactionHash: blockHash('35'),
      logIndex: 0,
    });
    const retry = collectDueEntityProviderActionRuntimeTxs(fixture.env, fixture.env.timestamp)[0];
    if (!retry) throw new Error('TEST_STALE_EPOCH_RETRY_MISSING');
    expect(() => applyRetryEntityProviderActionRuntimeTx(fixture.env, retry))
      .toThrow('ENTITY_PROVIDER_ACTION_PENDING_BOARD_EPOCH_STALE');
  });

  test('restore schedules never-attempted pending action immediately; backoff starts after durable attempt', async () => {
    const fixture = setup('retry-scheduler');
    await buildPending(fixture);
    expect(getNextEntityProviderActionRetryTimestamp(fixture.env)).toBe(0);
    const [retry] = collectDueEntityProviderActionRuntimeTxs(fixture.env, fixture.env.timestamp);
    expect(retry?.type).toBe('retryEntityProviderAction');
    const outbox = applyRetryEntityProviderActionRuntimeTx(fixture.env, retry!);
    registerPendingCommittedJOutbox(fixture.env, outbox);
    const action = requireActionJTx(outbox[0]?.jTxs[0]);
    const resultTx = makeEntityProviderActionResultRuntimeTx(action, 'EntityProviderActions', 'transientFailure', {
      message: 'rpc unavailable',
    });
    applyRecordEntityProviderActionResultRuntimeTx(fixture.env, resultTx);
    expect(collectDueEntityProviderActionRuntimeTxs(fixture.env, fixture.env.timestamp)).toEqual([]);
    expect(collectDueEntityProviderActionRuntimeTxs(fixture.env, fixture.env.timestamp + 60_000)).toHaveLength(1);
  });

  test('stale RPC result retires only its exact old attempt and never mutates a new generation', async () => {
    const fixture = setup('stale-result');
    const { pending } = await buildPending(fixture);
    const retry = collectDueEntityProviderActionRuntimeTxs(fixture.env, fixture.env.timestamp)[0]!;
    const outbox = applyRetryEntityProviderActionRuntimeTx(fixture.env, retry);
    registerPendingCommittedJOutbox(fixture.env, outbox);
    const oldAction = requireActionJTx(outbox[0]?.jTxs[0]);
    const oldResult = makeEntityProviderActionResultRuntimeTx(oldAction, 'EntityProviderActions', 'submitted', {
      txHash: `0x${'aa'.repeat(32)}`,
    });

    applyEntityProviderActionExecuted(fixture.replica.state, {
      entityId: fixture.replica.entityId,
      actionNonce: 1n,
      actionHash: pending.actionHash,
      actionKind: 0,
    }, 15);
    const next = handleEntityProviderTransfer(fixture.replica.state, transferTx(12n), fixture.env);
    fixture.replica.state = next.newState;
    fixture.replica.entityProviderActionSubmitState = {
      jurisdictionName: 'EntityProviderActions',
      actionHash: next.newState.entityProviderActionState!.pending!.actionHash,
      actionNonce: 2n,
      generation: 2,
      submitAttempts: 3,
      lastSubmittedAt: 9_999,
    };
    const newLocalBefore = structuredClone(fixture.replica.entityProviderActionSubmitState);
    applyRecordEntityProviderActionResultRuntimeTx(fixture.env, oldResult);
    expect(fixture.replica.entityProviderActionSubmitState).toEqual(newLocalBefore);
    expect(fixture.replica.state.entityProviderActionState?.pending?.generation).toBe(2);
    expect(fixture.env.runtimeState?.pendingCommittedJOutbox).toEqual([]);

    applyRecordEntityProviderActionResultRuntimeTx(fixture.env, oldResult);
    expect(fixture.replica.entityProviderActionSubmitState).toEqual(newLocalBefore);
    expect(fixture.replica.state.entityProviderActionState?.pending?.generation).toBe(2);
    expect(fixture.env.runtimeState?.pendingCommittedJOutbox).toEqual([]);
  });

  test('terminal revert remains fail-closed: receipt is durable but consensus pending is never cleared', async () => {
    const fixture = setup('terminal');
    const { pending } = await buildPending(fixture);
    const retry = collectDueEntityProviderActionRuntimeTxs(fixture.env, fixture.env.timestamp)[0]!;
    const outbox = applyRetryEntityProviderActionRuntimeTx(fixture.env, retry);
    registerPendingCommittedJOutbox(fixture.env, outbox);
    const action = requireActionJTx(outbox[0]?.jTxs[0]);
    const resultTx = makeEntityProviderActionResultRuntimeTx(action, 'EntityProviderActions', 'terminalFailure', {
      message: 'ERC1155 receiver rejected',
      adapterFailure: {
        category: 'terminal',
        code: 'CALL_EXCEPTION',
        message: 'ERC1155 receiver rejected',
      },
    });
    applyRecordEntityProviderActionResultRuntimeTx(fixture.env, resultTx);
    expect(fixture.replica.state.entityProviderActionState?.pending?.actionHash).toBe(pending.actionHash);
    expect(fixture.replica.entityProviderActionSubmitState?.terminalFailure?.message)
      .toBe('ERC1155 receiver rejected');
    expect(getNextEntityProviderActionRetryTimestamp(fixture.env)).toBeNull();
  });

  test('snapshot/restore preserves exact pending intent, local attempt, and durable outbox', async () => {
    const fixture = setup('snapshot-restore');
    const { pending: originalPending } = await buildPending(fixture);
    const cancellation = await applyEntityTx(fixture.env, fixture.replica.state, {
      type: 'entityProviderCancelAction',
      data: { actionHash: originalPending.actionHash },
    });
    if (cancellation.skippedError) throw cancellation.skippedError;
    fixture.replica.state = cancellation.newState;
    const pending = cancellation.newState.entityProviderActionState?.pending;
    if (!pending || pending.payload.kind !== 'cancelPendingAction') {
      throw new Error('TEST_SNAPSHOT_CANCEL_PENDING_MISSING');
    }
    fixture.replica.hankoWitness = new Map([[pending.actionHash, {
      hanko: `0x${'34'.repeat(65)}`,
      type: 'entityProviderAction',
      entityHeight: 2,
      createdAt: fixture.env.timestamp,
    }]]);
    const retry = collectDueEntityProviderActionRuntimeTxs(fixture.env, fixture.env.timestamp)[0]!;
    const outbox = applyRetryEntityProviderActionRuntimeTx(fixture.env, retry);
    registerPendingCommittedJOutbox(fixture.env, outbox);
    const machineSnapshot = buildDurableRuntimeMachineSnapshot(fixture.env);
    const replicaSnapshot = buildCanonicalEntityReplicaSnapshot(fixture.replica);
    const restored = createEmptyEnv('entity-provider-action:snapshot-restored');
    restoreDurableRuntimeSnapshot(restored, machineSnapshot);
    restored.eReplicas.set(
      `${replicaSnapshot.entityId}:${replicaSnapshot.signerId}`,
      replicaSnapshot,
    );
    expect(restored.runtimeState?.pendingCommittedJOutbox).toEqual(outbox);
    expect(replicaSnapshot.entityProviderActionSubmitState)
      .toEqual(fixture.replica.entityProviderActionSubmitState);
    expect(replicaSnapshot.state.entityProviderActionState?.pending?.actionHash).toBe(pending.actionHash);
    expect(collectDueEntityProviderActionRuntimeTxs(restored, restored.timestamp)).toEqual([]);

    const hydrated = hydrateEntityStateFromStorage({
      core: projectEntityCoreDoc(fixture.replica.state),
      accounts: new Map(),
      books: new Map(),
    });
    expect(hydrated.entityProviderActionState).toEqual(fixture.replica.state.entityProviderActionState);
  });

  test('isolated validators recompute one action hash and only real board quorum seals it', async () => {
    const seed = 'entity-provider-action:multisig';
    const signers = ['a', 'b', 'c'].map((label) =>
      deriveSignerAddressSync(seed, label).toLowerCase());
    const config: ConsensusConfig = {
      mode: 'proposer-based',
      threshold: 3n,
      validators: signers,
      shares: Object.fromEntries(signers.map((signerId) => [signerId, 1n])),
      jurisdiction: {
        address: address('a1'),
        name: 'EntityProviderActions',
        chainId: 31_337,
        depositoryAddress: address('a2'),
        entityProviderAddress: address('a3'),
      },
    };
    const proposerEnv = createEmptyEnv(`${seed}:proposer`);
    proposerEnv.scenarioMode = true;
    proposerEnv.timestamp = 1_000;
    proposerEnv.jReplicas.set('EntityProviderActions', {
      name: 'EntityProviderActions',
      blockNumber: 0n,
      stateRoot: null,
      mempool: [],
      blockDelayMs: 0,
      lastBlockTimestamp: 0,
      chainId: 31_337,
      position: { x: 0, y: 0, z: 0 },
      depositoryAddress: address('a2'),
      entityProviderAddress: address('a3'),
      contracts: { depository: address('a2'), entityProvider: address('a3') },
    });
    const entityId = hashBoard(encodeBoard(config, proposerEnv)).toLowerCase();
    const proposerState = baseState(entityId, config, proposerEnv.timestamp);
    installCertifiedBoardAuthority(proposerEnv, proposerState);
    const result = handleEntityProviderTransfer(
      proposerState,
      transferTx(),
      proposerEnv,
    );
    const intent = requireActionJTx(result.jOutputs[0]?.jTxs[0]).data.intent;
    const signatures = signers.map((signerId, index) => {
      const verifierEnv = createEmptyEnv(`${seed}:validator:${index}`);
      const key = deriveSignerKeySync(seed, ['a', 'b', 'c'][index]!);
      registerSignerKey(verifierEnv, signerId, key);
      expect(recomputeEntityProviderActionHash(structuredClone(intent))).toBe(intent.actionHash);
      return { signerId, signature: signAccountFrame(verifierEnv, signerId, intent.actionHash) };
    });
    await expect(buildQuorumHanko(
      proposerEnv,
      entityId,
      intent.actionHash,
      signatures.slice(0, 1),
      config,
    )).rejects.toThrow('BUILD_QUORUM_HANKO_INSUFFICIENT_QUORUM');
    const hanko = await buildQuorumHanko(
      proposerEnv,
      entityId,
      intent.actionHash,
      signatures,
      config,
    );
    expect((await verifyHankoForHash(hanko, intent.actionHash, entityId, proposerEnv)).valid).toBe(true);
  });

  test('common multisig pipeline makes every isolated validator replay and sign the action hash', async () => {
    const boardSeed = 'entity-provider-action:pipeline';
    const labels = ['a', 'b', 'c'];
    const signers = labels.map((label) => deriveSignerAddressSync(boardSeed, label).toLowerCase());
    const config: ConsensusConfig = {
      mode: 'proposer-based',
      threshold: 3n,
      validators: signers,
      shares: Object.fromEntries(signers.map((signerId) => [signerId, 1n])),
      jurisdiction: {
        address: address('a1'),
        name: 'EntityProviderActions',
        chainId: 31_337,
        depositoryAddress: address('a2'),
        entityProviderAddress: address('a3'),
      },
    };
    const preparationEnv = createEmptyEnv(`${boardSeed}:preparation`);
    preparationEnv.scenarioMode = true;
    preparationEnv.timestamp = 5_000;
    signers.forEach((signerId, index) =>
      registerSignerKey(preparationEnv, signerId, deriveSignerKeySync(boardSeed, labels[index]!)));
    const entityId = hashBoard(encodeBoard(config, preparationEnv)).toLowerCase();
    const genesis = baseState(entityId, config, preparationEnv.timestamp);
    installCertifiedBoardAuthority(preparationEnv, genesis);
    const proposalCommand = buildSignedEntityCommand(
      preparationEnv,
      genesis,
      signers[0]!,
      [buildCollectiveEntityProposalTx(signers[0]!, [transferTx()])],
    );
    const proposalFrame = await applyEntityFrame(
      preparationEnv,
      genesis,
      [signedEntityCommandTx(proposalCommand)],
      5_001,
    );
    const proposalId = Array.from(proposalFrame.newState.proposals.keys())[0];
    if (!proposalId) throw new Error('TEST_ACTION_PROPOSAL_ID_MISSING');
    const secondVote = buildSignedEntityCommand(
      preparationEnv,
      proposalFrame.newState,
      signers[1]!,
      [{ type: 'vote', data: { proposalId, voter: signers[1]!, choice: 'yes' } }],
    );
    const twoVotes = await applyEntityFrame(
      preparationEnv,
      proposalFrame.newState,
      [signedEntityCommandTx(secondVote)],
      5_002,
    );
    expect(twoVotes.newState.proposals.get(proposalId)?.status).toBe('pending');

    const makeIsolated = (index: number) => {
      const signerId = signers[index]!;
      const env = createEmptyEnv(`${boardSeed}:isolated:${index}`);
      env.scenarioMode = true;
      env.timestamp = 5_003;
      env.runtimeId = signerId;
      registerSignerKey(env, signerId, deriveSignerKeySync(boardSeed, labels[index]!));
      cacheCertifiedBoardNodes(env, getCertifiedBoardNodeStore(preparationEnv));
      env.jReplicas.set('EntityProviderActions', {
        name: 'EntityProviderActions',
        blockNumber: 0n,
        stateRoot: null,
        mempool: [],
        blockDelayMs: 0,
        lastBlockTimestamp: 0,
        chainId: 31_337,
        position: { x: 0, y: 0, z: 0 },
        depositoryAddress: address('a2'),
        entityProviderAddress: address('a3'),
        contracts: { depository: address('a2'), entityProvider: address('a3') },
      });
      const replica: EntityReplica = {
        entityId,
        signerId,
        state: structuredClone(twoVotes.newState),
        mempool: [],
        isProposer: index === 0,
      };
      env.eReplicas.set(`${entityId}:${signerId}`, replica);
      return { env, replica, signerId };
    };
    const third = makeIsolated(2);
    const thirdVote = buildSignedEntityCommand(
      third.env,
      third.replica.state,
      third.signerId,
      [{ type: 'vote', data: { proposalId, voter: third.signerId, choice: 'yes' } }],
    );
    const proposer = makeIsolated(0);
    const proposed = await applyEntityInput(proposer.env, proposer.replica, {
      entityId,
      signerId: proposer.signerId,
      entityTxs: [signedEntityCommandTx(thirdVote)],
    });
    const frame = proposed.workingReplica.proposal;
    if (!frame) throw new Error('TEST_ACTION_ENTITY_FRAME_MISSING');
    const actionManifest = frame.hashesToSign?.find(({ type }) => type === 'entityProviderAction');
    if (!actionManifest) throw new Error('TEST_ACTION_MANIFEST_MISSING');
    expect(frame.hashesToSign?.map(({ type }) => type)).toContain('entityProviderAction');

    const precommits = [];
    for (const index of [1, 2]) {
      const validator = index === 2 ? third : makeIsolated(index);
      const replayed = await applyEntityInput(validator.env, validator.replica, {
        entityId,
        signerId: validator.signerId,
        proposedFrame: structuredClone(frame),
      });
      expect(replayed.workingReplica.lockedFrame?.hashesToSign)
        .toEqual(frame.hashesToSign);
      const precommit = replayed.outputs.find((output) =>
        output.signerId === proposer.signerId && output.hashPrecommits?.has(validator.signerId));
      if (!precommit) throw new Error(`TEST_ACTION_PRECOMMIT_MISSING:${validator.signerId}`);
      expect(precommit.hashPrecommits?.get(validator.signerId)).toHaveLength(frame.hashesToSign!.length);
      precommits.push(precommit);
    }
    let leader = proposed;
    for (const precommit of precommits) {
      leader = await applyEntityInput(proposer.env, leader.workingReplica, structuredClone(precommit));
    }
    expect(leader.workingReplica.state.height).toBe(twoVotes.newState.height + 1);
    const sealed = requireActionJTx(leader.jOutputs[0]?.jTxs[0]);
    expect(sealed.data.intent.actionHash).toBe(actionManifest.hash);
    expect(sealed.data.signerId).toBe(proposer.signerId);
    expect(sealed.data.hankoSignature).toBeDefined();
    expect((await verifyHankoForHash(
      sealed.data.hankoSignature!,
      sealed.data.intent.actionHash,
      entityId,
      proposer.env,
    )).valid).toBe(true);
  });

  test('external ingress cannot forge action retry/result RuntimeTx authority markers', () => {
    const forged = {
      type: 'retryEntityProviderAction',
      data: {
        entityId: numberedEntityId(2n),
        signerId: address('11'),
        jurisdictionName: 'EntityProviderActions',
        actionHash: `0x${'22'.repeat(32)}`,
        actionNonce: 1n,
        generation: 1,
      },
    } as const;
    expect(() => assertEntityProviderActionRuntimeTxAuthorized(forged, false))
      .toThrow('ENTITY_PROVIDER_ACTION_RUNTIME_TX_EXTERNAL_INGRESS_REJECTED');
    const marked = markLocalEntityProviderActionRuntimeTx(structuredClone(forged));
    expect(() => assertEntityProviderActionRuntimeTxAuthorized(marked, false)).not.toThrow();
  });

  test('BrowserVM executes and reconciles real quorum-sealed transfer/release/cancel', async () => {
    const chainId = 31_337;
    const adapter = await createJAdapter({ mode: 'browservm', chainId });
    try {
      await adapter.deployStack();
      const browserVM = adapter.getBrowserVM();
      if (!browserVM) throw new Error('TEST_BROWSERVM_PROVIDER_MISSING');
      const seed = 'entity-provider-action:browservm';
      const privateKey = deriveSignerKeySync(seed, 'validator');
      const signerId = deriveSignerAddressSync(seed, 'validator').toLowerCase();
      const [entityNumber] = await browserVM.registerEntitiesWithSigners([{
        signerId,
        privateKey: `0x${Buffer.from(privateKey).toString('hex')}`,
      }]);
      if (!entityNumber) throw new Error('TEST_BROWSERVM_ENTITY_REGISTRATION_MISSING');
      const entityId = numberedEntityId(BigInt(entityNumber));
      const env = createEmptyEnv(seed);
      env.scenarioMode = true;
      env.timestamp = 2_000;
      registerSignerKey(env, signerId, privateKey);
      const config: ConsensusConfig = {
        mode: 'proposer-based',
        threshold: 1n,
        validators: [signerId],
        shares: { [signerId]: 1n },
        jurisdiction: {
          name: 'BrowserVMAction',
          address: 'browservm://action',
          chainId,
          depositoryAddress: adapter.addresses.depository,
          entityProviderAddress: adapter.addresses.entityProvider,
        },
      };
      env.jReplicas.set('BrowserVMAction', {
        name: 'BrowserVMAction',
        blockNumber: 0n,
        stateRoot: null,
        mempool: [],
        blockDelayMs: 0,
        lastBlockTimestamp: 0,
        chainId,
        position: { x: 0, y: 0, z: 0 },
        depositoryAddress: adapter.addresses.depository,
        entityProviderAddress: adapter.addresses.entityProvider,
        contracts: {
          depository: adapter.addresses.depository,
          entityProvider: adapter.addresses.entityProvider,
        },
        jadapter: adapter,
      });
      const state = baseState(entityId, config, env.timestamp);
      installCertifiedBoardAuthority(env, state);
      const result = handleEntityProviderTransfer(
        state,
        {
          type: 'entityProviderTransfer',
          data: { to: address('b1'), tokenId: BigInt(entityNumber), amount: 5n },
        },
        env,
      );
      const jTx = requireActionJTx(result.jOutputs[0]?.jTxs[0]);
      jTx.data.hankoSignature = buildSingleSignerHanko(
        entityId,
        jTx.data.intent.actionHash,
        privateKey,
      );
      const submitted = await adapter.submitTx(jTx, { env, signerId, timestamp: env.timestamp });
      if (!submitted.success) {
        throw new Error(`TEST_BROWSERVM_ACTION_SUBMIT_FAILED:${submitted.error ?? 'unknown'}`);
      }
      expect(submitted.success).toBe(true);
      expect(submitted.events?.filter((event) => event.name === 'EntityProviderActionExecuted'))
        .toHaveLength(1);
      expect(await adapter.getEntityProviderActionNonce?.(entityId)).toBe(1n);
      const receipt = await adapter.getEntityProviderActionReceipt?.(entityId, 1n);
      expect(receipt?.args['actionHash']).toBe(jTx.data.intent.actionHash);

      const reconciled = await adapter.submitTx(jTx, { env, signerId, timestamp: env.timestamp + 1 });
      expect(reconciled.success).toBe(true);
      expect(await adapter.getEntityProviderActionNonce?.(entityId)).toBe(1n);
      expect(reconciled.events?.filter((event) => event.name === 'EntityProviderActionExecuted'))
        .toHaveLength(1);

      const afterTransfer = structuredClone(result.newState);
      applyEntityProviderActionExecuted(afterTransfer, {
        entityId,
        actionNonce: 1n,
        actionHash: jTx.data.intent.actionHash,
        actionKind: 0,
      }, submitted.blockNumber ?? 1);
      const releaseResult = await applyEntityTx(env, afterTransfer, {
        type: 'entityProviderReleaseControlShares',
        data: { controlAmount: 3n, dividendAmount: 4n, purpose: 'BrowserVM integration' },
      });
      if (releaseResult.skippedError) throw releaseResult.skippedError;
      const releaseJTx = requireActionJTx(releaseResult.jOutputs[0]?.jTxs[0]);
      releaseJTx.data.hankoSignature = buildSingleSignerHanko(
        entityId,
        releaseJTx.data.intent.actionHash,
        privateKey,
      );
      const released = await adapter.submitTx(releaseJTx, {
        env,
        signerId,
        timestamp: env.timestamp + 2,
      });
      if (!released.success) {
        throw new Error(`TEST_BROWSERVM_RELEASE_SUBMIT_FAILED:${released.error ?? 'unknown'}`);
      }
      expect(await adapter.getEntityProviderActionNonce?.(entityId)).toBe(2n);
      const releaseEvent = released.events?.find((event) => event.name === 'EntityProviderActionExecuted');
      expect(Number(releaseEvent?.args['actionKind'])).toBe(1);
      expect(String(releaseEvent?.args['actionHash']).toLowerCase())
        .toBe(releaseJTx.data.intent.actionHash);

      const afterRelease = structuredClone(releaseResult.newState);
      applyEntityProviderActionExecuted(afterRelease, {
        entityId,
        actionNonce: 2n,
        actionHash: releaseJTx.data.intent.actionHash,
        actionKind: 1,
      }, released.blockNumber ?? 2);
      const pendingTransfer = await applyEntityTx(env, afterRelease, transferTx(1n));
      if (pendingTransfer.skippedError) throw pendingTransfer.skippedError;
      const pendingTransferJTx = requireActionJTx(pendingTransfer.jOutputs[0]?.jTxs[0]);
      pendingTransferJTx.data.hankoSignature = buildSingleSignerHanko(
        entityId,
        pendingTransferJTx.data.intent.actionHash,
        privateKey,
      );
      const cancellation = await applyEntityTx(env, pendingTransfer.newState, {
        type: 'entityProviderCancelAction',
        data: { actionHash: pendingTransferJTx.data.intent.actionHash },
      });
      if (cancellation.skippedError) throw cancellation.skippedError;
      const cancelJTx = requireActionJTx(cancellation.jOutputs[0]?.jTxs[0]);
      cancelJTx.data.hankoSignature = buildSingleSignerHanko(
        entityId,
        cancelJTx.data.intent.actionHash,
        privateKey,
      );
      const cancelled = await adapter.submitTx(cancelJTx, {
        env,
        signerId,
        timestamp: env.timestamp + 3,
      });
      if (!cancelled.success) {
        throw new Error(`TEST_BROWSERVM_CANCEL_SUBMIT_FAILED:${cancelled.error ?? 'unknown'}`);
      }
      expect(await adapter.getEntityProviderActionNonce?.(entityId)).toBe(3n);
      const cancelEvent = cancelled.events?.find((event) => event.name === 'EntityProviderActionCancelled');
      expect(String(cancelEvent?.args['cancelledActionHash']).toLowerCase())
        .toBe(pendingTransferJTx.data.intent.actionHash);
      expect(String(cancelEvent?.args['cancelHash']).toLowerCase())
        .toBe(cancelJTx.data.intent.actionHash);

      const cancelledOriginal = await adapter.submitTx(pendingTransferJTx, {
        env,
        signerId,
        timestamp: env.timestamp + 4,
      });
      expect(cancelledOriginal.success).toBe(true);
      expect(cancelledOriginal.events?.filter((event) => event.name === 'EntityProviderActionCancelled'))
        .toHaveLength(1);
      expect(await adapter.getEntityProviderActionNonce?.(entityId)).toBe(3n);
    } finally {
      await adapter.close();
    }
  }, 30_000);
});
