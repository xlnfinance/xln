import { describe, expect, test } from 'bun:test';

import { splitJOutboxForDurableSubmit , registerPendingCommittedJOutbox } from '../../../runtime/j-submit/j-submit-state';
import { resolveRuntimeWorkReason } from '../../../runtime/loop/loop-work';
import { createEmptyEnv } from '../../../runtime';
import {
  applyGovernanceSubmitResultRuntimeTx,
  makeGovernanceSubmitResultRuntimeTx,
  requireCanonicalGovernanceAttempt,
} from '../../../runtime/registration/governance-submit-state';
import type { JTx } from '../../../types/jurisdiction-runtime';
import type { JAdapter } from '../../../jurisdiction/adapter/types';
import { submitRuntimeJOutbox } from '../../../runtime/j-submit/j-submit';
import { ensureRuntimeInfrastructure } from '../../../runtime/envelope/replica-envelope';

const input = (jTx: JTx) => [{ jurisdictionName: 'Testnet', jTxs: [jTx] }];

describe('J submit maintenance lane', () => {
  test('keeps dev mint outside the durable financial attempt FSM', () => {
    const split = splitJOutboxForDurableSubmit(input({
      type: 'mint',
      entityId: `0x${'11'.repeat(32)}`,
      data: { entityId: `0x${'11'.repeat(32)}`, tokenId: 1, amount: 1n },
      timestamp: 1,
    }));
    expect(split.maintenance).toHaveLength(1);
    expect(split.durable).toEqual([]);
    expect(split.retries).toEqual([]);
  });

  test('keeps permissionless monotonic debt progress outside financial attempts', () => {
    const split = splitJOutboxForDurableSubmit(input({
      type: 'debtEnforcement',
      entityId: `0x${'22'.repeat(32)}`,
      data: { tokenId: 1, maxIterations: 10n },
      timestamp: 1,
    }));
    expect(split.maintenance[0]?.jTxs[0]?.type).toBe('debtEnforcement');
    expect(split.durable).toEqual([]);
    expect(split.retries).toEqual([]);
  });

  test('retains exact signed CONTROL governance bytes across transient retry', () => {
    const governanceTx: Extract<JTx, { type: 'entityProviderProposeControlBoard' }> = {
      type: 'entityProviderProposeControlBoard',
      entityId: `0x${'31'.repeat(32)}`,
      data: {
        targetEntityId: `0x${'32'.repeat(32)}`,
        newBoardHash: `0x${'41'.repeat(32)}`,
        boardEpoch: 2n,
        actionNonce: 7n,
        proposalHash: `0x${'51'.repeat(32)}`,
        supporterVotes: [{ entityId: `0x${'31'.repeat(32)}`, hankoSignature: '0x1234' }],
        signerId: `0x${'61'.repeat(20)}`,
      },
      timestamp: 1_000,
    };
    const split = splitJOutboxForDurableSubmit(input(governanceTx));
    expect(split.maintenance).toEqual([]);
    expect(split.retries).toEqual([]);
    const durable = split.durable[0]?.jTxs[0];
    if (!durable || durable.type !== 'entityProviderProposeControlBoard') {
      throw new Error('governance durable attempt missing');
    }
    const first = requireCanonicalGovernanceAttempt('Testnet', durable);
    expect(first).toMatchObject({ attemptNumber: 1, eligibleAt: 1_000 });

    const env = createEmptyEnv('governance-submit-test');
    env.state.timestamp = 2_000;
    registerPendingCommittedJOutbox(env, split.durable);
    const transient = makeGovernanceSubmitResultRuntimeTx('Testnet', durable, 'transientFailure', {
      message: 'rpc unavailable',
      adapterFailure: { category: 'transient', code: 'RPC_UNAVAILABLE', message: 'rpc unavailable' },
    });
    applyGovernanceSubmitResultRuntimeTx(env, transient);
    const retained = env.infrastructure?.pendingCommittedJOutbox?.[0]?.jTxs[0];
    if (!retained || retained.type !== 'entityProviderProposeControlBoard') {
      throw new Error('governance retry bytes missing');
    }
    expect(retained.data.supporterVotes).toEqual(governanceTx.data.supporterVotes);
    expect(retained.data.runtimeSubmitAttempt).toMatchObject({ attemptNumber: 2, attemptedAt: 2_000 });

    const submitted = makeGovernanceSubmitResultRuntimeTx('Testnet', retained, 'submitted', {
      txHash: `0x${'71'.repeat(32)}`,
    });
    applyGovernanceSubmitResultRuntimeTx(env, submitted);
    expect(env.infrastructure?.pendingCommittedJOutbox).toEqual([]);
  });

  test('a governance retry the loop reports ready is the retry post-commit submits', async () => {
    // Readiness read the wall clock while submission read the committed
    // timestamp, which an empty frame never advances: the loop re-ran empty
    // frames without submitting until unrelated input moved the clock.
    const governanceTx = makeGovernanceTx();
    const env = createEmptyEnv('governance-submit-clock');
    env.runtimeId = governanceTx.data.signerId;
    env.state.timestamp = 2_000;
    registerPendingCommittedJOutbox(env, splitJOutboxForDurableSubmit(input(governanceTx)).durable);
    const pending = () => env.infrastructure?.pendingCommittedJOutbox ?? [];
    const first = pending()[0]?.jTxs[0];
    if (first?.type !== 'entityProviderProposeControlBoard') throw new Error('governance attempt missing');
    applyGovernanceSubmitResultRuntimeTx(env, makeGovernanceSubmitResultRuntimeTx('Testnet', first, 'transientFailure', {
      message: 'rpc unavailable',
      adapterFailure: { category: 'transient', code: 'RPC_UNAVAILABLE', message: 'rpc unavailable' },
    }));
    let submitCalls = 0;
    installTestnetAdapter(env, async () => {
      submitCalls += 1;
      return { success: true, txHash: `0x${'72'.repeat(32)}` };
    });
    const queued: unknown[] = [];
    const deps = { enqueueRuntimeInputs: (_env: unknown, _inputs: unknown, runtimeTxs?: unknown[]) => queued.push(...(runtimeTxs ?? [])) };

    // Due by the wall clock, not by the committed timestamp 2_000.
    expect(resolveRuntimeWorkReason(env, { runtimeInputHasQueuedWork: () => false })).toBe('committed-j-outbox');
    await submitRuntimeJOutbox(env, pending(), deps as never);
    expect(submitCalls).toBe(1);
    expect(queued).toHaveLength(1);
  });
});

const makeGovernanceTx = (): Extract<JTx, { type: 'entityProviderProposeControlBoard' }> => ({
  type: 'entityProviderProposeControlBoard',
  entityId: `0x${'31'.repeat(32)}`,
  data: {
    targetEntityId: `0x${'32'.repeat(32)}`,
    newBoardHash: `0x${'41'.repeat(32)}`,
    boardEpoch: 2n,
    actionNonce: 7n,
    proposalHash: `0x${'51'.repeat(32)}`,
    supporterVotes: [{ entityId: `0x${'31'.repeat(32)}`, hankoSignature: '0x1234' }],
    signerId: `0x${'61'.repeat(20)}`,
  },
  timestamp: 1_000,
});

const installTestnetAdapter = (env: ReturnType<typeof createEmptyEnv>, submitTx: JAdapter['submitTx']): void => {
  env.state.jReplicas = new Map([['Testnet', {
    name: 'Testnet',
    chainId: 31337,
    blockNumber: 0n,
    stateRoot: null,
    mempool: [],
    blockDelayMs: 0,
    lastBlockTimestamp: 0,
    position: { x: 0, y: 0, z: 0 },
  }]]);
  ensureRuntimeInfrastructure(env).liveJAdapters = new Map([['Testnet', {
    mode: 'rpc',
    pollNow: async () => {},
    submitTx,
  } as unknown as JAdapter]]);
};

describe('J submit maintenance failures', () => {
  test('a failed or throwing maintenance submit is logged, never a Runtime halt', async () => {
    // mint and debtEnforcement carry no Entity result to journal. Any RPC
    // error during, e.g., the UI's "enforce debts" threw post-commit and
    // halted the Runtime.
    const env = createEmptyEnv('j-submit-maintenance-failure');
    env.state.jReplicas = new Map([['Testnet', {
      name: 'Testnet',
      chainId: 31337,
      blockNumber: 0n,
      stateRoot: null,
      mempool: [],
      blockDelayMs: 0,
      lastBlockTimestamp: 0,
      position: { x: 0, y: 0, z: 0 },
    }]]);
    let submitCalls = 0;
    ensureRuntimeInfrastructure(env).liveJAdapters = new Map([['Testnet', {
      pollNow: async () => {},
      submitTx: async () => {
        submitCalls += 1;
        if (submitCalls === 1) return { success: false, error: 'header not found' };
        throw new Error('ECONNRESET');
      },
    } as unknown as JAdapter]]);
    const debt: JTx = {
      type: 'debtEnforcement',
      entityId: `0x${'22'.repeat(32)}`,
      data: { tokenId: 1, maxIterations: 10n },
      timestamp: 1,
    };
    const queued: unknown[] = [];
    const deps = { enqueueRuntimeInputs: (_env: unknown, _inputs: unknown, runtimeTxs?: unknown[]) => queued.push(...(runtimeTxs ?? [])) };

    await submitRuntimeJOutbox(env, input(debt), deps as never);
    await submitRuntimeJOutbox(env, input(debt), deps as never);

    expect(submitCalls).toBe(2);
    expect(queued).toEqual([]);
  });
});
