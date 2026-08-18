import { describe, expect, test } from 'bun:test';

import { splitJOutboxForDurableSubmit } from '../../../runtime/j-submit/j-submit-state';
import { registerPendingCommittedJOutbox } from '../../../runtime/j-submit/j-submit-state';
import { createEmptyEnv } from '../../../runtime';
import {
  applyGovernanceSubmitResultRuntimeTx,
  makeGovernanceSubmitResultRuntimeTx,
  requireCanonicalGovernanceAttempt,
} from '../../../runtime/registration/governance-submit-state';
import type { JTx } from '../../../types/jurisdiction-runtime';

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
});
