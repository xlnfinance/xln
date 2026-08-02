import { expect, test } from 'bun:test';

import { computeAccountStateRoot } from '../account/state-root';
import { executeCrontab, initCrontab, HUB_PENDING_BROADCAST_STALE_MS } from '../entity/scheduler';
import { createEmptyEnv } from '../runtime';
import type { EntityReplica, EntityState, JurisdictionConfig } from '../entity/types';
import { makeAccount } from './helpers/cross-j';

const entityId = `0x${'c5'.repeat(32)}`;
const signerId = `0x${'da'.repeat(20)}`;

const jurisdiction: JurisdictionConfig = {
  name: 'Testnet',
  address: 'http://localhost:8545',
  chainId: 31337,
  depositoryAddress: `0x${'11'.repeat(20)}`,
  entityProviderAddress: `0x${'22'.repeat(20)}`,
};

const makeHubState = (frozenTimestamp: number, lastSubmittedAt: number): EntityState => ({
  entityId,
  height: 0,
  timestamp: frozenTimestamp,
  nonces: new Map(),
  proposals: new Map(),
  config: {
    mode: 'proposer-based',
    validators: [signerId],
    shares: { [signerId]: 1n },
    threshold: 1n,
    jurisdiction,
  },
  reserves: new Map(),
  accounts: new Map(),
  deferredAccountProposals: new Map(),
  lastFinalizedJHeight: 0,
  jBlockChain: [],
  profile: { name: 'H1', isHub: true, avatar: '', bio: '', website: '' },
  htlcRoutes: new Map(),
  htlcFeesEarned: 0n,
  lockBook: new Map(),
  swapTradingPairs: [],
  hubRebalanceConfig: {
    matchingStrategy: 'amount',
    policyVersion: 1,
    routingFeePPM: 1,
    baseFee: 0n,
    swapTakerFeeBps: 0,
    disputeAutoFinalizeMode: 'auto',
    minCollateralThreshold: 0n,
    rebalanceLiquidityFeeBps: 1n,
    rebalanceTimeoutMs: 600_000,
  },
  jBatchState: {
    batch: null,
    lastBroadcast: lastSubmittedAt,
    sentBatch: {
      entityNonce: 7,
      lastSubmittedAt,
      submitAttempts: 1,
    },
  },
} as unknown as EntityState);

/**
 * A hub that sent a J-batch which never confirms must eventually abort and
 * requeue it. The age of that batch used to be measured on the entity's own
 * frame clock, but state.timestamp only advances when the entity commits a
 * frame, and this handler refuses to produce one while a sentBatch is pending.
 * The age therefore froze at the moment of submission, the stale threshold was
 * never reached, and the hub latched on the unconfirmed batch forever. Every
 * later rebalance request was accepted and then silently stalled behind it.
 *
 * lastSubmittedAt is stamped from env.timestamp, so the check must read the
 * same clock.
 */
test('a hub aborts an unconfirmed sent batch even while its own frame clock is frozen', async () => {
  const submittedAt = 1_000_000;
  const frozenEntityClock = submittedAt + 500;

  const env = createEmptyEnv('hub-rebalance-stale-batch');
  env.scenarioMode = true;
  env.quietRuntimeLogs = true;
  // The runtime clock keeps advancing past the stale threshold while the
  // entity's own clock stays where the blocked handler left it.
  env.state.timestamp = submittedAt + HUB_PENDING_BROADCAST_STALE_MS + 5_000;

  const state = makeHubState(frozenEntityClock, submittedAt);
  state.crontabState = initCrontab();
  for (const task of state.crontabState.tasks.values()) task.lastRun = 0;

  const replica = { entityId, signerId, mempool: [], isProposer: true, state } as unknown as EntityReplica;
  env.state.eReplicas.set(`${entityId}:${signerId}`, replica);

  const outputs = await executeCrontab(env, replica, state.crontabState, {
    manualBroadcastInInput: false,
    accountChanges: new Set(),
  });

  const abortTxs = outputs
    .flatMap((output) => output.entityTxs ?? [])
    .filter((tx) => tx.type === 'j_abort_sent_batch');

  expect(abortTxs.length, 'stale sent batch must be aborted so the hub can rebalance again')
    .toBeGreaterThan(0);
  expect((abortTxs[0]!.data as { requeueToCurrent?: boolean }).requeueToCurrent).toBe(true);
});

test('a hub still waits while the sent batch is younger than the stale threshold', async () => {
  const submittedAt = 1_000_000;

  const env = createEmptyEnv('hub-rebalance-fresh-batch');
  env.scenarioMode = true;
  env.quietRuntimeLogs = true;
  env.state.timestamp = submittedAt + 1_000;

  const state = makeHubState(submittedAt + 500, submittedAt);
  state.crontabState = initCrontab();
  for (const task of state.crontabState.tasks.values()) task.lastRun = 0;

  const replica = { entityId, signerId, mempool: [], isProposer: true, state } as unknown as EntityReplica;
  env.state.eReplicas.set(`${entityId}:${signerId}`, replica);

  const outputs = await executeCrontab(env, replica, state.crontabState, {
    manualBroadcastInInput: false,
    accountChanges: new Set(),
  });

  const abortTxs = outputs
    .flatMap((output) => output.entityTxs ?? [])
    .filter((tx) => tx.type === 'j_abort_sent_batch');

  expect(abortTxs, 'a fresh in-flight batch must not be aborted').toEqual([]);
});

test('hub crontab cannot unilaterally clear a bilateral rebalance request', async () => {
  const userId = `0x${'f5'.repeat(32)}`;
  const tokenId = 1;
  const requestedAmount = 500n;
  const hubAccount = makeAccount(entityId, userId, jurisdiction);
  hubAccount.state.requestedRebalance.set(tokenId, requestedAmount);
  hubAccount.state.requestedRebalanceFeeState.set(tokenId, {
    requestId: 'bilateral-request',
    feeTokenId: tokenId,
    feePaidUpfront: 10n ** 30n,
    requestedAmount,
    policyVersion: 1,
    requestedAt: 1,
    requestedByLeft: false,
  });
  const userAccount = structuredClone(hubAccount);
  const bilateralRoot = computeAccountStateRoot(userAccount.state);

  const env = createEmptyEnv('hub-rebalance-bilateral-clear');
  env.scenarioMode = true;
  env.quietRuntimeLogs = true;
  env.state.timestamp = 1_000_000;
  const state = makeHubState(env.state.timestamp, 0);
  state.jBatchState = undefined;
  state.accounts.set(userId, hubAccount);
  state.crontabState = initCrontab();
  for (const task of state.crontabState.tasks.values()) task.lastRun = 0;
  const replica = { entityId, signerId, mempool: [], isProposer: true, state } as EntityReplica;
  env.state.eReplicas.set(`${entityId}:${signerId}`, replica);

  await executeCrontab(env, replica, state.crontabState, {
    manualBroadcastInInput: false,
    accountChanges: new Set(),
  });

  expect(computeAccountStateRoot(hubAccount.state)).toBe(bilateralRoot);
  expect(hubAccount.state.requestedRebalance.get(tokenId)).toBe(requestedAmount);
  expect(hubAccount.state.requestedRebalanceFeeState.has(tokenId)).toBe(true);
});
