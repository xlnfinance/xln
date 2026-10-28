import { expect, test } from 'bun:test';
import { applyEntityTx } from '../../../entity/tx/apply';
import { createEmptyEnv } from '../../../runtime';
import { buildPreparedCrossJurisdictionRoute, buildCrossJurisdictionPullBinding, cloneCrossJurisdictionRoute, deriveCrossJurisdictionPrivateSeed, buildCrossJurisdictionPullReveal, withCanonicalCrossJurisdictionRouteHash } from '../../../extensions/cross-j';
import { getPullLockAdmissionError } from '../../../account/tx/handlers/settlement/pull';
import { applySourceHubCrossJurisdictionFillProgress } from '../../../entity/tx/handlers/account-cross-j-followups';
import { flushDeferredHashLadderReveals, queueHashLadderRevealRegistration } from '../../../entity/tx/j-events-htlc';
import { handleCrossJurisdictionSalvageEntityTx } from '../../../entity/tx/handlers/cross-j/salvage';
import type { CrossJurisdictionSwapRoute } from '../../../types/cross-jurisdiction';
import type { AccountTx } from '../../../types/account';
import { addr, entity, makeJurisdiction, jref, makeState, installJurisdictions, getTestAccountForWrite } from '../../helpers/cross-j';
import { clearEntityFrameEvents, readEntityFrameEvents } from '../../../entity/frame-events';
import { createEmptyBatch, initJBatch } from '../../../jurisdiction/machine/batch';
import { computeEntityConsensusSectionDigestsCold } from '../../../entity/consensus/state-root';
import { safeStringify } from '../../../protocol/serialization';

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
  expect(result.skippedError).toBeUndefined();
  expect(result.outputs).toEqual([]);
  expect(readEntityFrameEvents(result.newState)).toEqual([{ type: 'status', message: `❌ Cross-j register ${route.orderId} rejected before Account queue: Cross-j pull ladders do not match` }]);
});

for (const role of ['sourceHub', 'targetHub', 'sourceUser', 'targetUser'] as const) {
  test(`review 2 reamend: ${role} rejects a resting opening missing its target pull`, async () => {
    const { state, env } = context(role);
    const route = resting();
    delete route.targetPull;
    const before = computeEntityConsensusSectionDigestsCold(state);
    const result = await applyEntityTx(env, state, { type: 'registerCrossJurisdictionSwap', data: { route } });
    expect(result.skippedError).toContain(`CROSS_J_REGISTER_OPENING_PULLS_MISSING:${route.orderId}`);
    expect(computeEntityConsensusSectionDigestsCold(result.newState)).toEqual(before);
    expect(result.outputs).toEqual([]);
    expect(result.accountTxs ?? []).toEqual([]);
    expect(readEntityFrameEvents(result.newState)).toEqual([]);
  });
}

for (const role of ['sourceUser', 'targetUser'] as const) {
  test(`review 2 reamend: ${role} stores mismatched ladders without hub admission`, async () => {
    const { state, env } = context(role);
    const route = resting();
    route.targetPull = { ...route.targetPull!, partialRoot: `0x${'ab'.repeat(32)}` };
    const result = await applyEntityTx(env, state, { type: 'registerCrossJurisdictionSwap', data: { route } });
    expect(result.skippedError).toBeUndefined();
    expect(result.newState.crossJurisdictionSwaps!.get(route.orderId)).toEqual(route);
    expect(result.outputs).toEqual([]);
    expect(result.accountTxs ?? []).toEqual([]);
    expect(readEntityFrameEvents(result.newState)).toEqual([{ type: 'status', message: `🌉 Cross-j swap ${route.orderId} registered` }]);
  });
}

test('review 3: confirmed equal target ratio cannot republish a timestamp refresh', async () => {
  const { state } = context('targetUser');
  const route = { ...resting(), targetRegistryFillRatio: 65535 };
  state.crossJurisdictionSwaps!.set(route.orderId, route);
  const binary = buildCrossJurisdictionPullReveal(route, 65535, deriveCrossJurisdictionPrivateSeed('review-seed', route)).binary;
  const result = await handleCrossJurisdictionSalvageEntityTx(state, { type: 'crossJurisdictionSalvage', data: { routeId: route.orderId, binary, fillRatio: 65535 } });
  expect(result.jOutputs ?? []).toEqual([]);
  expect(result.hashesToSign ?? []).toEqual([]);
  expect(result.newState.crossJurisdictionSwaps!.get(route.orderId)).toEqual(route);
  expect(() => queueHashLadderRevealRegistration(state, entity('03'), route.targetPull!, { fillRatio: 65535 }, true)).toThrow('TARGET_REVEAL_REQUIRES_STANDALONE_PUBLICATION');
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

test('review 7: salvage publishes independently of a full draft', async () => {
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
  expect(result.outputs).toEqual([]);
  expect(result.jOutputs).toHaveLength(1);
  expect(result.hashesToSign).toHaveLength(1);
  expect(result.newState.jBatchState).toEqual(state.jBatchState);
  expect(readEntityFrameEvents(result.newState)).toEqual([]);
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

for (const sent of [false, true]) {
  for (const full of [false, true]) {
    test(`q50 salvage: active dispute with ${sent ? 'sent batch' : 'no sent batch'} and ${full ? 'full' : 'available'} draft`, async () => {
      const { state } = context('targetUser');
      const route = resting();
      state.crossJurisdictionSwaps!.set(route.orderId, route);
      getTestAccountForWrite(state, entity('03')).activeDispute = {
        startedByLeft: false, initialProofbodyHash: `0x${'00'.repeat(32)}`, initialNonce: 1, initialProposerIsLeft: false,
        disputeTimeout: 21, disputeStartTimestamp: 1, jNonce: 1, starterInitialArguments: '0x', starterCounterArguments: '0x',
        starterCounterProofCommitment: `0x${'00'.repeat(32)}`, observedOnChain: true,
      };
      state.jBatchState = initJBatch();
      const unrelated: ReturnType<typeof createEmptyBatch>['hashLadderRegistrations'][number] = { counterpartyEntity: entity('03'), targetRole: true,
        fullHash: `0x${'00'.repeat(32)}`, partialRoot: `0x${'00'.repeat(32)}`,
        witness: { fillRatio: 65535, fullSecret: `0x${'00'.repeat(32)}`,
          reveals: [`0x${'00'.repeat(32)}`, `0x${'00'.repeat(32)}`, `0x${'00'.repeat(32)}`, `0x${'00'.repeat(32)}`] } };
      if (full) for (let i = 0; i < 32; i++) state.jBatchState.batch.hashLadderRegistrations.push({ ...unrelated, fullHash: `0x${i.toString(16).padStart(64, '0')}` });
      if (sent) {
        state.jBatchState.status = 'sent';
        state.jBatchState.sentBatch = { batch: { ...createEmptyBatch(), hashLadderRegistrations: [unrelated] },
          batchHash: `0x${'ab'.repeat(32)}`, encodedBatch: '0x', entityNonce: 1,
          firstSubmittedAt: 1000, lastSubmittedAt: 1000, submitAttempts: 1 };
      }
      const beforeBatch = structuredClone(state.jBatchState);
      const binary = buildCrossJurisdictionPullReveal(route, 65535, deriveCrossJurisdictionPrivateSeed('review-seed', route)).binary;
      const tx = { type: 'crossJurisdictionSalvage' as const, data: { routeId: route.orderId, binary: binary.toUpperCase(), fillRatio: 65535 } };
      const result = await handleCrossJurisdictionSalvageEntityTx(state, tx);
      expect(result.outputs).toEqual([]);
      expect(readEntityFrameEvents(result.newState)).toEqual([]);
      expect(result.jOutputs).toHaveLength(1);
      expect(result.hashesToSign).toHaveLength(1);
      expect(result.newState.jBatchState).toEqual(beforeBatch);
      const witness = { fillRatio: 65535, fullSecret: binary, reveals: unrelated.witness.reveals };
      expect(result.jOutputs![0]!.jTxs[0]).toMatchObject({ type: 'hashLadderReveal', entityId: state.entityId,
        data: { registration: { counterpartyEntity: entity('03'), targetRole: true,
          fullHash: route.targetPull!.fullHash, partialRoot: route.targetPull!.partialRoot, witness } } });
      expect(result.newState.crossJurisdictionSwaps!.get(route.orderId)).toEqual({ ...route, pendingTargetRegistryReveal: witness });
      clearEntityFrameEvents(result.newState);
      const retry = await handleCrossJurisdictionSalvageEntityTx(result.newState, tx);
      expect(retry.outputs).toEqual([]);
      expect(retry.jOutputs ?? []).toEqual([]);
      expect(retry.hashesToSign ?? []).toEqual([]);
      expect(readEntityFrameEvents(retry.newState)).toEqual([]);
      expect(retry.newState.jBatchState).toEqual(result.newState.jBatchState);
      expect(retry.newState.crossJurisdictionSwaps!.get(route.orderId)).toEqual(result.newState.crossJurisdictionSwaps!.get(route.orderId));
    });
  }
}

for (const fillRatio of [0, 65535]) {
  test(`q50 salvage: empty route ID with claim ${fillRatio} preserves status precedence`, async () => {
    const { state } = context('targetUser');
    const before = computeEntityConsensusSectionDigestsCold(state);
    const result = await handleCrossJurisdictionSalvageEntityTx(state, { type: 'crossJurisdictionSalvage', data: { routeId: '', binary: `0x${'00'.repeat(32)}`, fillRatio } });
    expect(result.outputs).toEqual([]);
    expect(readEntityFrameEvents(result.newState)).toEqual([{ type: 'status', message: fillRatio === 0
      ? '🌉 Cross-j reveal port ignored for : invalid result'
      : '🌉 Cross-j reveal port  skipped: route not owned here' }]);
    expect(computeEntityConsensusSectionDigestsCold(result.newState)).toEqual(before);
  });
}

for (const prefix of ['001g', '0x01', '+001', '  01']) {
  test(`q50 salvage: partial ratio prefix ${safeStringify(prefix)} follows TS parseInt`, async () => {
    const { state } = context('targetUser');
    const route = resting();
    state.crossJurisdictionSwaps!.set(route.orderId, route);
    const reveal = buildCrossJurisdictionPullReveal(route, 1, deriveCrossJurisdictionPrivateSeed('review-seed', route));
    const binary = `0x${prefix}${reveal.binary.slice(6)}`;
    const result = await handleCrossJurisdictionSalvageEntityTx(state, { type: 'crossJurisdictionSalvage', data: { routeId: route.orderId, binary, fillRatio: 1 } });
    expect(result.outputs).toEqual([]);
    expect(readEntityFrameEvents(result.newState)).toEqual([]);
    expect(result.jOutputs).toHaveLength(1);
    expect(result.hashesToSign).toHaveLength(1);
    expect(result.newState.crossJurisdictionSwaps!.get(route.orderId)!.pendingTargetRegistryReveal).toEqual({ fillRatio: 1, fullSecret: `0x${'00'.repeat(32)}`, reveals: reveal.reveals });
    expect(result.newState.jBatchState).toEqual(state.jBatchState);
  });
}

for (const [binary, detail] of [
  ['abcd', 'HASHLADDER_BINARY_INVALID_HEX'], ['0x0', 'HASHLADDER_BINARY_INVALID_HEX'],
  [`0x${'gg'.repeat(32)}`, 'HASHLADDER_FULL_BINARY_INVALID'],
  ['0xgg', 'HASHLADDER_BINARY_INVALID_LENGTH:1'],
  [`0x0000${'00'.repeat(128)}`, 'HASHLADDER_PARTIAL_BINARY_RATIO_INVALID:0'],
  [`0xffff${'00'.repeat(128)}`, 'HASHLADDER_PARTIAL_BINARY_RATIO_INVALID:65535'],
  [`0xgggg${'00'.repeat(128)}`, 'HASHLADDER_PARTIAL_BINARY_RATIO_INVALID:NaN'],
  [`0x0001${'gg'.repeat(128)}`, 'HASHLADDER_PARTIAL_BINARY_REVEALS_INVALID'],
  [`0x${'00'.repeat(32)}`, 'HASHLADDER_BINARY_VERIFY_FAILED'],
] as const) {
  test(`q50 salvage: exact invalid evidence status ${detail}`, async () => {
    const { state } = context('targetUser');
    const route = resting();
    state.crossJurisdictionSwaps!.set(route.orderId, route);
    const before = computeEntityConsensusSectionDigestsCold(state);
    const result = await handleCrossJurisdictionSalvageEntityTx(state, { type: 'crossJurisdictionSalvage', data: { routeId: route.orderId, binary, fillRatio: 65535 } });
    expect(result.outputs).toEqual([]);
    expect(readEntityFrameEvents(result.newState)).toEqual([{ type: 'status', message: `❌ Cross-j reveal port ${route.orderId} invalid pull binary: ${detail}` }]);
    expect(computeEntityConsensusSectionDigestsCold(result.newState)).toEqual(before);
    expect(result.newState.jBatchState).toEqual(state.jBatchState);
  });
}

test('q48 salvage: uppercase-prefix full evidence publishes before the target dispute', async () => {
  const { state } = context('targetUser');
  const route = resting();
  state.crossJurisdictionSwaps!.set(route.orderId, route);
  const binary = buildCrossJurisdictionPullReveal(route, 65535, deriveCrossJurisdictionPrivateSeed('review-seed', route)).binary;
  expect(state.accounts.get(route.target.entityId)!.activeDispute).toBeUndefined();
  const before = computeEntityConsensusSectionDigestsCold(state);
  const result = await handleCrossJurisdictionSalvageEntityTx(state, { type: 'crossJurisdictionSalvage', data: { routeId: route.orderId, binary: binary.toUpperCase(), fillRatio: 65535 } });
  expect(result.outputs).toEqual([]);
  expect(result.newState.crossJurisdictionSwaps!.get(route.orderId)).toEqual({
    ...route, pendingTargetRegistryReveal: {
      fillRatio: 65535, fullSecret: binary,
      reveals: Array.from({ length: 4 }, () => `0x${'00'.repeat(32)}`),
    },
  });
  expect(result.newState.jBatchState).toEqual(state.jBatchState);
  expect(computeEntityConsensusSectionDigestsCold(state)).toEqual(before);
  expect(readEntityFrameEvents(result.newState)).toEqual([]);
  expect(result.jOutputs).toHaveLength(1);
  expect(result.hashesToSign).toHaveLength(1);
});

test('q48 salvage: raw uppercase empty prefix is zero fill without state mutation', async () => {
  const { state } = context('targetUser');
  const route = resting();
  state.crossJurisdictionSwaps!.set(route.orderId, route);
  expect(state.accounts.get(route.target.entityId)!.activeDispute).toBeUndefined();
  const before = computeEntityConsensusSectionDigestsCold(state);
  const result = await handleCrossJurisdictionSalvageEntityTx(state, { type: 'crossJurisdictionSalvage', data: { routeId: route.orderId, binary: '0X', fillRatio: 65535 } });
  expect(result.outputs).toEqual([]);
  expect(result.newState.crossJurisdictionSwaps!.get(route.orderId)).toEqual(route);
  expect(computeEntityConsensusSectionDigestsCold(result.newState)).toEqual(before);
  expect(computeEntityConsensusSectionDigestsCold(state)).toEqual(before);
  expect(readEntityFrameEvents(result.newState)).toEqual([
    { type: 'status', message: `🌉 Cross-j reveal port ignored for ${route.orderId}: zero fill` },
  ]);
});

for (const status of ['resting', 'settled'] as const) {
  for (const missingPull of [false, true]) {
    test(`q46 salvage: empty binary on owned ${status} route with ${missingPull ? 'missing' : 'valid'} target pull`, async () => {
      const { state } = context('targetUser');
      const route = { ...resting(), status };
      if (missingPull) delete route.targetPull;
      state.crossJurisdictionSwaps!.set(route.orderId, route);
      const before = computeEntityConsensusSectionDigestsCold(state);
      const result = handleCrossJurisdictionSalvageEntityTx(state, { type: 'crossJurisdictionSalvage', data: { routeId: route.orderId, binary: '0x', fillRatio: 1 } });
      if (missingPull) {
        await expect(result).rejects.toThrow('CROSS_J_REVEAL_PORT_TARGET_PULL_MISSING');
      } else {
        const applied = await result;
        expect(applied.outputs).toEqual([]);
        expect(computeEntityConsensusSectionDigestsCold(applied.newState)).toEqual(before);
        expect(applied.newState.crossJurisdictionSwaps!.get(route.orderId)).toEqual(route);
        expect(readEntityFrameEvents(applied.newState)).toEqual(status === 'settled' ? [] : [
          { type: 'status', message: `🌉 Cross-j reveal port ignored for ${route.orderId}: empty result` },
        ]);
      }
      expect(computeEntityConsensusSectionDigestsCold(state)).toEqual(before);
    });
  }
}

for (const ownership of ['missing collection', 'unknown route', 'non-owner'] as const) {
  test(`q46 salvage: positive claim with ${ownership} returns the ownership status only`, async () => {
    const { state } = context(ownership === 'non-owner' ? 'targetHub' : 'targetUser');
    const route = resting();
    const binary = buildCrossJurisdictionPullReveal(route, 65535, deriveCrossJurisdictionPrivateSeed('review-seed', route)).binary;
    if (ownership === 'non-owner') {
      delete route.targetPull; // Unowned mirror corruption must not enter owned-route validation.
      state.crossJurisdictionSwaps!.set(route.orderId, route);
    } else if (ownership === 'missing collection') delete state.crossJurisdictionSwaps;
    const before = computeEntityConsensusSectionDigestsCold(state);
    const result = await handleCrossJurisdictionSalvageEntityTx(state, { type: 'crossJurisdictionSalvage', data: { routeId: route.orderId, binary, fillRatio: 1 } });
    expect(result.outputs).toEqual([]);
    expect(computeEntityConsensusSectionDigestsCold(result.newState)).toEqual(before);
    expect(computeEntityConsensusSectionDigestsCold(state)).toEqual(before);
    expect(readEntityFrameEvents(result.newState)).toEqual([
      { type: 'status', message: `🌉 Cross-j reveal port ${route.orderId} skipped: route not owned here` },
    ]);
  });
}

test('review 13: private seed whitespace canonicalizes before hashing', () => {
  expect(deriveCrossJurisdictionPrivateSeed(' review-seed\n', intent())).toBe(deriveCrossJurisdictionPrivateSeed('review-seed', intent()));
});

for (const existing of ['confirmed', 'queued', 'pending'] as const) {
  test(`review 3 amend: retry 100 remains a no-op with ${existing} 100 and queued 200`, () => {
    const { state } = context('sourceHub');
    const route = resting();
    const seed = deriveCrossJurisdictionPrivateSeed('review-seed', route);
    const reveal = (ratio: number) => buildCrossJurisdictionPullReveal(route, ratio, seed);
    state.crossJurisdictionSwaps!.set(route.orderId, route);
    if (existing === 'confirmed') route.sourceRegistryFillRatio = 100;
    if (existing === 'pending') route.pendingSourceRegistryReveal = reveal(100);
    state.jBatchState = initJBatch();
    for (const ratio of existing === 'queued' ? [100, 200] : [200]) {
      // The older queued witness lives in recovery; the newer draft is canonical.
      const batch = ratio === 100 ? initJBatch().batch : state.jBatchState.batch;
      batch.hashLadderRegistrations.push({ counterpartyEntity: entity('01'), targetRole: false,
        fullHash: route.sourcePull!.fullHash, partialRoot: route.sourcePull!.partialRoot,
        witness: { fillRatio: ratio, fullSecret: `0x${'00'.repeat(32)}`, reveals: [`0x${'00'.repeat(32)}`, `0x${'00'.repeat(32)}`, `0x${'00'.repeat(32)}`, `0x${'00'.repeat(32)}`] } });
      if (ratio === 100) state.jBatchState.recoveryBatches = [batch];
    }
    const before = structuredClone(state.jBatchState);
    expect(queueHashLadderRevealRegistration(state, entity('01'), route.sourcePull!, reveal(100), false)).toBe('already-queued');
    expect(state.jBatchState).toEqual(before);
    expect(() => queueHashLadderRevealRegistration(state, entity('01'), route.sourcePull!, reveal(150), false)).toThrow('REGISTRATION_CONFLICT');
  });
}

test('review 3 amend: pending 200 prevents a new stale ratio 150', () => {
  const { state } = context('sourceHub');
  const route = resting();
  const seed = deriveCrossJurisdictionPrivateSeed('review-seed', route);
  route.pendingSourceRegistryReveal = buildCrossJurisdictionPullReveal(route, 200, seed);
  state.crossJurisdictionSwaps!.set(route.orderId, route);
  expect(() => queueHashLadderRevealRegistration(state, entity('01'), route.sourcePull!, buildCrossJurisdictionPullReveal(route, 150, seed), false)).toThrow('REGISTRATION_CONFLICT');
});

for (const fillRatio of [-1, -0.25, -1e-7, 0, 0.75, 65536, 65536.75, 1e21]) {
  test(`review 12 amend: valid salvage binary with claimed ${fillRatio} is a status without route mutation`, async () => {
    const { state } = context('targetUser');
    const route = resting();
    state.crossJurisdictionSwaps!.set(route.orderId, route);
    const binary = buildCrossJurisdictionPullReveal(route, 65535, deriveCrossJurisdictionPrivateSeed('review-seed', route)).binary;
    const result = await handleCrossJurisdictionSalvageEntityTx(state, { type: 'crossJurisdictionSalvage', data: { routeId: route.orderId, binary, fillRatio } });
    expect(result.outputs).toEqual([]);
    expect(result.newState.crossJurisdictionSwaps!.get(route.orderId)).toEqual(route);
    expect(readEntityFrameEvents(result.newState)).toEqual([{ type: 'status', message: Math.floor(fillRatio) <= 0
      ? `🌉 Cross-j reveal port ignored for ${route.orderId}: invalid result`
      : `❌ Cross-j reveal port ${route.orderId} fill mismatch: claimed ${Math.floor(fillRatio)}, verified 65535` }]);
  });
}

for (const status of ['resting', 'settled'] as const) {
  test(`review 12 amend: owned ${status} missing target pull remains fatal with an oversized claim`, async () => {
    const { state } = context('targetUser');
    const route = resting();
    const binary = buildCrossJurisdictionPullReveal(route, 65535, deriveCrossJurisdictionPrivateSeed('review-seed', route)).binary;
    delete route.targetPull;
    route.status = status;
    state.crossJurisdictionSwaps!.set(route.orderId, route);
    const before = computeEntityConsensusSectionDigestsCold(state);
    await expect(handleCrossJurisdictionSalvageEntityTx(state, { type: 'crossJurisdictionSalvage', data: { routeId: route.orderId, binary, fillRatio: 65536 } })).rejects.toThrow('CROSS_J_REVEAL_PORT_TARGET_PULL_MISSING');
    expect(computeEntityConsensusSectionDigestsCold(state)).toEqual(before);
  });
}

for (const freeSlot of [false, true]) {
  test(`review 3 reamend: salvage retry preserves a deferred witness with ${freeSlot ? 'available' : 'full'} capacity`, async () => {
    const { state } = context('targetUser');
    const route = resting();
    const reveal = buildCrossJurisdictionPullReveal(route, 100, deriveCrossJurisdictionPrivateSeed('review-seed', route));
    const pending = { fillRatio: 100, fullSecret: `0x${'00'.repeat(32)}`, reveals: reveal.reveals! };
    route.pendingTargetRegistryReveal = pending;
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
    expect(flushDeferredHashLadderReveals(state, entity('03'))).toBe(0);
    expect(state.crossJurisdictionSwaps!.get(route.orderId)!.pendingTargetRegistryReveal).toEqual(pending);
    if (freeSlot) state.jBatchState.batch.hashLadderRegistrations.pop();
    const before = computeEntityConsensusSectionDigestsCold(state);
    const beforeBatch = structuredClone(state.jBatchState);
    const result = await handleCrossJurisdictionSalvageEntityTx(state, { type: 'crossJurisdictionSalvage', data: { routeId: route.orderId, binary: reveal.binary, fillRatio: 100 } });
    expect(computeEntityConsensusSectionDigestsCold(result.newState)).toEqual(before);
    expect(result.newState.jBatchState).toEqual(beforeBatch);
    expect(result.newState.crossJurisdictionSwaps!.get(route.orderId)).toEqual({ ...route, pendingTargetRegistryReveal: pending });
    expect(result.outputs).toEqual([]);
    expect(readEntityFrameEvents(result.newState)).toEqual([]);
    if (!freeSlot) result.newState.jBatchState!.batch.hashLadderRegistrations.pop();
    expect(flushDeferredHashLadderReveals(result.newState, entity('03'))).toBe(0);
    expect(result.newState.jBatchState!.batch.hashLadderRegistrations).toEqual(beforeBatch.batch.hashLadderRegistrations.slice(0, 31));
    expect(result.newState.crossJurisdictionSwaps!.get(route.orderId)!.pendingTargetRegistryReveal).toEqual(pending);
    expect(result.jOutputs ?? []).toEqual([]);
    expect(result.hashesToSign ?? []).toEqual([]);
  });
}

for (const missing of [false, true]) {
  test(`review 5 amend: source user ${missing ? 'missing Account' : 'clock mismatch'} remains fatal`, async () => {
    const { state, env } = context('sourceUser');
    const route = intent();
    if (missing) state.accounts.delete(entity('02'));
    else route.sourceDisputeConfig = { leftResponseSeconds: 11, rightResponseSeconds: 10 };
    await expect(applyEntityTx(env, state, { type: 'prepareCrossJurisdictionSwap', data: { route } })).rejects.toThrow(missing ? 'CROSS_J_PREPARED_SOURCE_ACCOUNT_MISSING' : 'CROSS_J_PREPARED_SOURCE_ACCOUNT_CLOCK_MISMATCH');
    expect(state.crossJurisdictionAuthorizations?.has(route.orderId) ?? false).toBe(false);
  });
}

test('review 13 amend: exact ECMAScript trim set determines ladder commitments', () => {
  const plain = deriveCrossJurisdictionPrivateSeed('review-seed', intent());
  const trim = [0x09, 0x0a, 0x0b, 0x0c, 0x0d, 0x20, 0xa0, 0x1680,
    0x2000, 0x2001, 0x2002, 0x2003, 0x2004, 0x2005, 0x2006, 0x2007, 0x2008, 0x2009, 0x200a,
    0x2028, 0x2029, 0x202f, 0x205f, 0x3000, 0xfeff];
  for (const codepoint of trim) {
    const char = String.fromCodePoint(codepoint);
    expect(deriveCrossJurisdictionPrivateSeed(`${char}review-seed${char}`, intent())).toBe(plain);
    expect(() => deriveCrossJurisdictionPrivateSeed(char, intent())).toThrow('CRYPTO_DETERMINISM_VIOLATION');
  }
  for (const codepoint of [0x85, 0x180e, 0x200b]) {
    const char = String.fromCodePoint(codepoint);
    expect(deriveCrossJurisdictionPrivateSeed(`${char}review-seed${char}`, intent())).not.toBe(plain);
    expect(deriveCrossJurisdictionPrivateSeed(char, intent())).toMatch(/^0x[0-9a-f]{64}$/);
  }
});
