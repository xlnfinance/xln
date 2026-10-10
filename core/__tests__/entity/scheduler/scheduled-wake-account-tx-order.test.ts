import { expect, test } from 'bun:test';

import { createEmptyEnv } from '../../../runtime';
import { initCrontab } from '../../../entity/scheduler';
import { applyEntityFrameWithMaterializedTestInfraContext } from '../../helpers/entity-frame';
import { collectDueScheduledWakeJobs } from '../../../runtime/mempool/scheduled-wake';
import { collectDerivedDeadlines } from '../../../entity/scheduler/derived-deadlines';
import type { ScheduledWakeTx } from '../../../entity/scheduler/wake/scheduled-wake-validation';
import { deriveEntityEncryptionPublicKey } from '../../../entity/auth/crypto';
import { deriveSignerKeySync } from '../../../account/crypto';
import { PersistentEntityAccountMap } from '../../../entity/state/persistent-account-map';
import { PersistentAccountStateMap } from '../../../account/state/persistent-state-map';
import { computeEntityAccountValueHash } from '../../../entity/consensus/state-root';
import { createEmptyAccountJClaimAccumulator } from '../../../account/j-claims/j-claim-accumulator';
import { createDefaultDelta } from '../../../account/state/delta';
import { installJurisdictions, makeJurisdiction } from '../../helpers/cross-j';
import type { AccountReplica } from '../../../types/account';
import type { EntityState } from '../../../entity/types';

const HUB = `0x${'10'.repeat(32)}`;
const BORROWER = `0x${'30'.repeat(32)}`;
const PROPOSER = `0x${'44'.repeat(20)}`;
const LOCK_ID = `0x${'7a'.repeat(32)}`;
const POSITION_ID = 'lend-1111111111111111';
const LOAN_ID = 'loan-2222222222222222';
/** One wake timestamp shared by the loan term and the lock timelock. */
const TRIGGER_AT = 9_000;
const JURISDICTION = makeJurisdiction('WakeOrder', 31_337, '88', '89');

const makeAccount = (): AccountReplica => {
  const delta = createDefaultDelta(1);
  delta.collateral = 20_000n;
  delta.leftCreditLimit = 20_000n;
  delta.rightCreditLimit = 20_000n;
  // The hub is LEFT and holds the lock it is about to time out.
  delta.leftHold = 100n;
  return {
    state: {
      leftEntity: HUB,
      rightEntity: BORROWER,
      domain: {
        chainId: JURISDICTION.chainId,
        depositoryAddress: JURISDICTION.depositoryAddress,
      },
      watchSeed: `0x${'99'.repeat(32)}`,
      deltas: PersistentAccountStateMap.fromEntries('deltas', [[1, delta]]),
      disputeConfig: { leftResponseSeconds: 576, rightResponseSeconds: 576 },
      requestedRebalance: PersistentAccountStateMap.empty('requestedRebalance'),
      requestedRebalanceFeeState: PersistentAccountStateMap.empty('requestedRebalanceFeeState'),
      locks: PersistentAccountStateMap.fromEntries('locks', [[LOCK_ID, {
        lockId: LOCK_ID,
        hashlock: LOCK_ID,
        timelock: BigInt(TRIGGER_AT),
        revealBeforeHeight: 0,
        amount: 100n,
        tokenId: 1,
        senderIsLeft: true,
        createdHeight: 1,
        createdTimestamp: 1_000,
      }]]),
      swapOffers: PersistentAccountStateMap.empty('swapOffers'),
      pulls: PersistentAccountStateMap.empty('pulls'),
      leftPendingJClaims: createEmptyAccountJClaimAccumulator(),
      rightPendingJClaims: createEmptyAccountJClaimAccumulator(),
      lastFinalizedJHeight: 0,
      jNonce: 0,
    },
    status: 'active',
    mempool: [],
    currentFrame: {
      height: 1,
      timestamp: 1_000,
      jHeight: 0,
      accountTxs: [],
      prevFrameHash: `0x${'55'.repeat(32)}`,
      deltas: [],
      stateHash: `0x${'55'.repeat(32)}`,
      accountStateRoot: `0x${'66'.repeat(32)}`,
      byLeft: true,
    },
    currentHeight: 1,
    rollbackCount: 0,
    proofHeader: { fromEntity: HUB, toEntity: BORROWER, nextProofNonce: 1 },
    pendingWithdrawals: PersistentAccountStateMap.empty('pendingWithdrawals'),
    shadow: {
      rebalance: {
        policy: PersistentAccountStateMap.empty('rebalanceShadowPolicy'),
        submittedAtByToken: PersistentAccountStateMap.empty('rebalanceShadowSubmitted'),
      },
    },
  };
};

const makeState = (timestamp: number): EntityState => ({
  entityId: HUB,
  entityEncryptionPublicKey: deriveEntityEncryptionPublicKey(
    `0x${Buffer.from(deriveSignerKeySync(HUB, 'entity-encryption')).toString('hex')}`,
    HUB,
  ),
  height: 0,
  timestamp,
  nonces: new Map(),
  proposals: new Map(),
  config: {
    mode: 'proposer-based',
    threshold: 1n,
    validators: [PROPOSER],
    shares: { [PROPOSER]: 1n },
    jurisdiction: JURISDICTION,
  },
  reserves: new Map(),
  accounts: PersistentEntityAccountMap
    .empty(HUB, computeEntityAccountValueHash)
    .updated(BORROWER, makeAccount()),
  deferredAccountProposals: new Map(),
  lastFinalizedJHeight: 0,
  profile: { name: 'Hub', isHub: true, avatar: '', bio: '', website: '' },
  paybook: { entries: new Map(), feesEarned: 0n },
  swapTradingPairs: [],
  crontabState: initCrontab(),
  lending: {
    pools: new Map([[POSITION_ID, {
      positionId: POSITION_ID,
      hubEntityId: HUB,
      lenderEntityId: `0x${'20'.repeat(32)}`,
      tokenId: 1,
      principalAmount: 10_000n,
      availableAmount: 7_500n,
      borrowedAmount: 2_500n,
      interestBps: 100,
      termId: '1d',
      termMs: 86_400_000,
      createdAt: 1_000,
      updatedAt: 1_000,
      status: 'open',
    }]]),
    loans: new Map([[LOAN_ID, {
      requestId: 'borrow-3333333333333333',
      loanId: LOAN_ID,
      hubEntityId: HUB,
      borrowerEntityId: BORROWER,
      lenderEntityId: `0x${'20'.repeat(32)}`,
      positionId: POSITION_ID,
      tokenId: 1,
      principalAmount: 2_500n,
      interestAmount: 25n,
      repaymentAmount: 2_525n,
      repaidAmount: 0n,
      interestBps: 100,
      termId: '1d',
      termMs: 86_400_000,
      openedAt: 1_000,
      dueAt: TRIGGER_AT,
      updatedAt: 1_000,
      status: 'active',
    }]]),
  },
});

/**
 * One wake, one overdue loan and one expired HTLC lock on the same Account at
 * the same trigger time. The two deadlines reach `accountTxs` by different
 * routes — lending writes `context.accountTxs` inside the `scheduledWake`
 * transaction, HTLC timeouts return a nested `processHtlcTimeouts` EntityTx —
 * so the emitted Account-transaction order is a real protocol choice.
 *
 * `applyRegularEntityTx` runs the nested approved `processHtlcTimeouts` before
 * it drains the wake's own `accountTxs`, so the htlc_resolve is admitted first.
 * Rust must reproduce exactly this: `execute_crontab` pushes
 * `ProcessHtlcTimeouts` before `SettleOverdueLending`, and
 * `append_scheduled_account_txs` consumes that list in order.
 */
test('a wake with an overdue loan and an expired lock emits the htlc resolve before the lending revoke', async () => {
  const env = createEmptyEnv('scheduled-wake-account-tx-order');
  env.state.timestamp = TRIGGER_AT;
  env.scenarioMode = true;
  installJurisdictions(env, JURISDICTION);
  const state = makeState(TRIGGER_AT);

  // Both deadlines are due, at the same trigger time, in the one wake.
  expect(collectDerivedDeadlines(state, TRIGGER_AT).map(deadline => deadline.id)).toEqual([
    `htlc-timeout:${LOCK_ID}`,
    `lending-overdue:${LOAN_ID}`,
  ]);
  const jobs = collectDueScheduledWakeJobs(state, TRIGGER_AT, false);
  const tx: ScheduledWakeTx = {
    type: 'scheduledWake',
    data: { version: 1, proposerSignerId: PROPOSER, dueAt: TRIGGER_AT, jobs },
  };

  const result = await applyEntityFrameWithMaterializedTestInfraContext(env, state, [tx], TRIGGER_AT);

  const proposed = result.newState.accounts.get(BORROWER)?.pendingFrame?.accountTxs ?? [];
  expect(proposed.map(entry => entry.type)).toEqual(['htlc_resolve']);
  expect(result.newState.lending?.loans.get(LOAN_ID)?.status).toBe('defaulted');
});
