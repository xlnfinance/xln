import { expect, test } from 'bun:test';
import { applyEntityTx } from '../../../entity/tx/apply';
import { createEmptyEnv } from '../../../runtime';
import { buildPreparedCrossJurisdictionRoute, buildCrossJurisdictionPullBinding, cloneCrossJurisdictionRoute, deriveCrossJurisdictionPrivateSeed, buildCrossJurisdictionPullReveal, withCanonicalCrossJurisdictionRouteHash } from '../../../extensions/cross-j';
import { getPullLockAdmissionError } from '../../../account/tx/handlers/settlement/pull';
import { applySourceHubCrossJurisdictionFillProgress } from '../../../entity/tx/handlers/account-cross-j-followups';
import { queueHashLadderRevealRegistration } from '../../../entity/tx/j-events-htlc';
import { handleCrossJurisdictionSalvageEntityTx } from '../../../entity/tx/handlers/cross-j/salvage';
import type { CrossJurisdictionSwapRoute } from '../../../types/cross-jurisdiction';
import type { AccountTx } from '../../../types/account';
import { addr, entity, makeJurisdiction, jref, makeState, installJurisdictions, getTestAccountForWrite } from '../../helpers/cross-j';
import { initJBatch } from '../../../jurisdiction/machine/batch';

const sourceJ = makeJurisdiction('source', 1, '11', '12');
const targetJ = makeJurisdiction('target', 2, '21', '22');
const intent = (): CrossJurisdictionSwapRoute => ({
  orderId: 'review-route', makerEntityId: entity('01'), hubEntityId: entity('02'),
  sourceSignerId: addr('31'), sourceHubSignerId: addr('32'), targetHubSignerId: addr('33'), targetSignerId: addr('34'),
  source: { jurisdiction: jref(sourceJ), entityId: entity('01'), counterpartyEntityId: entity('02'), tokenId: 1, amount: 1000n },
  target: { jurisdiction: jref(targetJ), entityId: entity('03'), counterpartyEntityId: entity('04'), tokenId: 1, amount: 900n },
  sourceDisputeConfig: { leftResponseSeconds: 10, rightResponseSeconds: 10 },
  targetDisputeConfig: { leftResponseSeconds: 10, rightResponseSeconds: 10 },
  status: 'intent', createdAt: 1000, updatedAt: 1000, expiresAt: 61000,
});
const prepared = () => buildPreparedCrossJurisdictionRoute(intent(), { runtimeSeed: 'review-seed', now: 1000 });
const resting = (): CrossJurisdictionSwapRoute => ({ ...prepared(), status: 'resting' });
const context = (role: 'sourceHub' | 'targetHub' | 'sourceUser' | 'targetUser') => {
  const source = role.startsWith('source');
  const hub = role.endsWith('Hub');
  const self = source ? (hub ? '02' : '01') : (hub ? '03' : '04');
  const peer = source ? (hub ? '01' : '02') : (hub ? '04' : '03');
  const signer = source ? (hub ? '32' : '31') : (hub ? '33' : '34');
  const state = makeState(entity(self), addr(signer), source ? sourceJ : targetJ, entity(peer));
  const env = createEmptyEnv('review');
  env.state.timestamp = 1000;
  installJurisdictions(env, sourceJ, targetJ);
  return { state, env };
};
const targetLock = (route: CrossJurisdictionSwapRoute): Extract<AccountTx, { type: 'cross_pull_lock' }> => ({
  type: 'cross_pull_lock', data: { pullId: route.targetPull!.pullId, tokenId: route.targetPull!.tokenId,
    amount: route.targetPull!.signedAmount, fullHash: route.targetPull!.fullHash, partialRoot: route.targetPull!.partialRoot,
    crossJurisdiction: buildCrossJurisdictionPullBinding(route, 'target'), crossJurisdictionRoute: route },
});

test('review 2: target Account rejects a source hub substituting the target ladder', () => {
  const route = resting();
  route.targetPull = { ...route.targetPull!, fullHash: `0x${'ab'.repeat(32)}` };
  const { state } = context('targetHub');
  expect(getPullLockAdmissionError(state.accounts.get(entity('04'))!.state, targetLock(route))).not.toBeNull();
});

test('review 2: target Account rejects a non-derived pull ID', () => {
  const route = resting();
  route.targetPull = { ...route.targetPull!, pullId: 'substituted-id' };
  const { state } = context('targetHub');
  expect(getPullLockAdmissionError(state.accounts.get(entity('04'))!.state, targetLock(route))).not.toBeNull();
});

test('review 2: target hub refuses registration of different ladders', async () => {
  const { state, env } = context('targetHub');
  const route = resting();
  route.targetPull = { ...route.targetPull!, partialRoot: `0x${'ab'.repeat(32)}` };
  const result = await applyEntityTx(env, state, { type: 'registerCrossJurisdictionSwap', data: { route } });
  expect(result.newState.crossJurisdictionSwaps!.has(route.orderId)).toBe(false);
  expect(result.accountTxs ?? []).toEqual([]);
});

test('review 3: confirmed equal target ratio cannot queue a timestamp refresh', () => {
  const { state } = context('targetUser');
  const route = { ...resting(), targetRegistryFillRatio: 65535 };
  state.crossJurisdictionSwaps!.set(route.orderId, route);
  expect(queueHashLadderRevealRegistration(state, entity('03'), route.targetPull!, { fillRatio: 65535, fullSecret: `0x${'ab'.repeat(32)}` }, true)).toBe('already-queued');
});

test('review 4: late registration cannot resurrect a terminal route', async () => {
  const { state, env } = context('targetHub');
  const route = resting();
  state.crossJurisdictionSwaps!.set(route.orderId, { ...route, status: 'cancelled' });
  const result = await applyEntityTx(env, state, { type: 'registerCrossJurisdictionSwap', data: { route } });
  expect(result.newState.crossJurisdictionSwaps!.get(route.orderId)!.status).toBe('cancelled');
  expect(result.accountTxs ?? []).toEqual([]);
});

test('review 5: expired raw intent never becomes durable hub work', async () => {
  const { state, env } = context('sourceHub');
  const route = { ...intent(), expiresAt: 1000 };
  const result = await applyEntityTx(env, state, { type: 'prepareCrossJurisdictionSwap', data: { route } });
  expect(result.newState.crossJurisdictionSwaps!.has(route.orderId)).toBe(false);
  expect(result.outputs).toEqual([]);
});

test('review 5: route clock differing from the source Account is not stored', async () => {
  const { state, env } = context('sourceHub');
  const route = intent();
  route.sourceDisputeConfig = { leftResponseSeconds: 11, rightResponseSeconds: 10 };
  const result = await applyEntityTx(env, state, { type: 'prepareCrossJurisdictionSwap', data: { route } });
  expect(result.newState.crossJurisdictionSwaps!.has(route.orderId)).toBe(false);
  expect(result.outputs).toEqual([]);
});

test('review 6: uppercase pull hashes reject instead of diverging in storage', () => {
  const route = resting();
  for (const pull of [route.sourcePull!, route.targetPull!]) pull.fullHash = `0x${pull.fullHash.slice(2).toUpperCase()}`;
  const { state } = context('targetHub');
  expect(getPullLockAdmissionError(state.accounts.get(entity('04'))!.state, targetLock(route))).not.toBeNull();
});

test('review 7: deferred salvage drains a full draft without a sent batch', async () => {
  const { state } = context('targetUser');
  const route = resting();
  state.crossJurisdictionSwaps!.set(route.orderId, route);
  getTestAccountForWrite(state, entity('03')).activeDispute = {
    startedByLeft: false, initialProofbodyHash: `0x${'00'.repeat(32)}`, initialNonce: 1, initialProposerIsLeft: false,
    disputeTimeout: 21, disputeStartTimestamp: 1, jNonce: 1, starterInitialArguments: '0x', starterCounterArguments: '0x',
    starterCounterProofCommitment: `0x${'00'.repeat(32)}`, observedOnChain: true,
  };
  state.jBatchState = initJBatch();
  for (let i = 0; i < 32; i++) {
    state.jBatchState.batch.hashLadderRegistrations.push({ counterpartyEntity: entity('03'), targetRole: true,
      fullHash: `0x${i.toString(16).padStart(64, '0')}`, partialRoot: `0x${'00'.repeat(32)}`,
      witness: { fillRatio: 65535, fullSecret: `0x${'00'.repeat(32)}`, reveals: [`0x${'00'.repeat(32)}`, `0x${'00'.repeat(32)}`, `0x${'00'.repeat(32)}`, `0x${'00'.repeat(32)}`] } });
  }
  const binary = buildCrossJurisdictionPullReveal(route, 65535, deriveCrossJurisdictionPrivateSeed('review-seed', route)).binary;
  const result = await handleCrossJurisdictionSalvageEntityTx(state, { type: 'crossJurisdictionSalvage', data: { routeId: route.orderId, binary, fillRatio: 65535 } });
  expect(result.outputs.flatMap(output => output.entityTxs ?? []).map(tx => tx.type)).toEqual(['j_broadcast']);
  expect(result.newState.crossJurisdictionSwaps!.get(route.orderId)!.pendingTargetRegistryReveal).toBeDefined();
});

test('review 8: same-stack explicit market is a typed prepare reject', async () => {
  const { state, env } = context('sourceHub');
  const route = intent();
  route.target = { ...route.target, jurisdiction: route.source.jurisdiction, tokenId: 2 };
  route.bookOwnerEntityId = entity('02');
  route.venueId = 'explicit-same-stack';
  const result = await applyEntityTx(env, state, { type: 'prepareCrossJurisdictionSwap', data: { route } });
  expect(result.skippedError).toContain('DISTINCT_STACKS_REQUIRED');
  expect(result.newState.crossJurisdictionSwaps!.has(route.orderId)).toBe(false);
});

test('review 9: clear of raw intent is a typed reject', async () => {
  const { state, env } = context('sourceHub');
  const route = withCanonicalCrossJurisdictionRouteHash(intent());
  state.crossJurisdictionSwaps!.set(route.orderId, route);
  const result = await applyEntityTx(env, state, { type: 'requestCrossJurisdictionClear', data: { orderId: route.orderId, cancelRemainder: true } });
  expect(result.skippedError).toContain('CROSS_J_CLEAR_INTENT_UNMATERIALIZED');
});

test('review 10: materialization absorbs exact intent cancelled earlier in the frame', async () => {
  const { state, env } = context('sourceHub');
  const route = prepared();
  const prior = cloneCrossJurisdictionRoute(route);
  delete prior.sourcePull; delete prior.targetPull;
  prior.status = 'cancelled'; prior.updatedAt = 1001;
  state.crossJurisdictionSwaps!.set(route.orderId, prior);
  const result = await applyEntityTx(env, state, { type: 'materializeCrossJurisdictionSwap', data: { route, proposerSignerId: addr('32') } });
  expect(result.outputs).toEqual([]);
  expect(result.newState.crossJurisdictionSwaps!.get(route.orderId)!.status).toBe('cancelled');
});

test('review 11: equal sequence and ratio with different amounts is a typed reject', () => {
  const { state, env } = context('sourceHub');
  const route = { ...resting(), fillSeq: 1, cumulativeFillRatio: 100, fillNumerator: 100n, fillDenominator: 65535n, executionSourceAmount: 1n, executionTargetAmount: 1n };
  state.crossJurisdictionSwaps!.set(route.orderId, route);
  let caught: unknown;
  try { applySourceHubCrossJurisdictionFillProgress(env, state, { orderId: route.orderId, routeHash: route.routeHash!, fillSeq: 1, cumulativeFillRatio: 100, cumulativeExecutionSourceAmount: 2n, cumulativeExecutionTargetAmount: 1n }, [], []); } catch (error) { caught = error; }
  expect(caught).toMatchObject({ disposition: 'reject', code: 'CROSS_J_EXECUTION_NOTICE_CONFLICT' });
});

test('review 12: forged salvage ratio is absorbed without state changes', async () => {
  const { state } = context('targetUser');
  const route = resting();
  state.crossJurisdictionSwaps!.set(route.orderId, route);
  const binary = buildCrossJurisdictionPullReveal(route, 65535, deriveCrossJurisdictionPrivateSeed('review-seed', route)).binary;
  const result = await handleCrossJurisdictionSalvageEntityTx(state, { type: 'crossJurisdictionSalvage', data: { routeId: route.orderId, binary, fillRatio: 1 } });
  expect(result.outputs).toEqual([]);
  expect(result.newState.crossJurisdictionSwaps!.get(route.orderId)).toEqual(route);
});

test('review 13: private seed whitespace canonicalizes before hashing', () => {
  expect(deriveCrossJurisdictionPrivateSeed(' review-seed\n', intent())).toBe(deriveCrossJurisdictionPrivateSeed('review-seed', intent()));
});
