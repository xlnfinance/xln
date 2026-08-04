/**
 * Pay-as-you-go pull settlement (`cross_pull_reveal`) and payer expiry
 * (`cross_pull_expire`).
 *
 * The dispute-side property under test: before restating existed, an open
 * partial fill carried `claimedRatio = 0` in the signed ProofBody, so a forced
 * account close burned the entire committed progress unless the beneficiary
 * could present the ladder binary as argument evidence. After a committed
 * reveal the level lives in offdelta + `claimedRatio` and needs no arguments.
 */
import { describe, expect, test } from 'bun:test';

import { applyAccountTx } from '../account/tx/apply';
import { getIncomingAccountDeadlineViolation } from '../account/consensus/deadline-policy';
import { buildAccountProofBody } from '../protocol/dispute/proof-builder';
import {
  buildDisputeArgumentsFromSnapshot,
  captureDisputeArgumentSnapshot,
  storeDisputeArgumentSnapshot,
} from '../protocol/dispute/arguments';
import {
  buildCommittedCrossJurisdictionPullBinding,
  buildCrossJurisdictionCloseProof,
  buildCrossJurisdictionPullBinding,
  buildCrossJurisdictionPullReveal,
  buildPreparedCrossJurisdictionRoute,
  deriveCrossJurisdictionPrivateSeed,
} from '../extensions/cross-j/index';
import type { AccountFrame, AccountReplica, AccountTx } from '../types/account';
import type { CrossJurisdictionSwapRoute } from '../types/cross-jurisdiction';
import { addr, entity, jref, makeAccount, makeJurisdiction } from './helpers/cross-j';

const RUNTIME_SEED = 'cross-pull-restating-test';
const NOW = 1_000;
// buildPreparedCrossJurisdictionRoute: sourceRevealUntil = expiresAt + 60s.
const EXPIRES_AT = 61_000;
const SOURCE_REVEAL_UNTIL = EXPIRES_AT + 60_000;

// Exact fraction 1/2 -> uint16_ceil coarse ratio 32768; 3/4 -> 49152.
const HALF_RATIO = 32_768;
const FULL_RATIO = 65_535;

type Fixture = {
  account: AccountReplica;
  route: CrossJurisdictionSwapRoute;
  privateSeed: string;
  /** byLeft that authorizes reveal/close on the source leg (the Hub side). */
  hubIsLeft: boolean;
  payerIsLeft: boolean;
  pullId: string;
  tokenId: number;
};

const makeSourceLegFixture = async (orderId: string): Promise<Fixture> => {
  const eth = makeJurisdiction('Ethereum', 1, '11', '12');
  const base = makeJurisdiction('Base', 8453, '21', '22');
  const sourceUser = entity('51');
  const sourceHub = entity('52');
  const route = buildPreparedCrossJurisdictionRoute(
    {
      orderId,
      makerEntityId: sourceUser,
      hubEntityId: sourceHub,
      source: {
        jurisdiction: jref(eth),
        entityId: sourceUser,
        counterpartyEntityId: sourceHub,
        tokenId: 1,
        amount: 1_000n,
      },
      target: {
        jurisdiction: jref(base),
        entityId: entity('53'),
        counterpartyEntityId: entity('54'),
        tokenId: 2,
        amount: 900n,
      },
      status: 'resting',
      createdAt: NOW,
      updatedAt: NOW,
      expiresAt: EXPIRES_AT,
    },
    { runtimeSeed: RUNTIME_SEED, sourceDisputeDelayMs: 5_000, now: NOW },
  );
  const restingRoute = { ...route, status: 'resting' as const };
  const account = makeAccount(sourceHub, sourceUser, eth);
  const sourcePull = restingRoute.sourcePull!;
  const lock = await applyAccountTx(
    account,
    {
      type: 'cross_pull_lock',
      data: {
        pullId: sourcePull.pullId,
        tokenId: sourcePull.tokenId,
        amount: sourcePull.signedAmount,
        revealedUntilTimestamp: sourcePull.revealedUntilTimestamp,
        fullHash: sourcePull.fullHash,
        partialRoot: sourcePull.partialRoot,
        crossJurisdiction: buildCrossJurisdictionPullBinding(restingRoute, 'source'),
        crossJurisdictionRoute: restingRoute,
      },
    },
    sourcePull.signedAmount > 0n,
    2_000,
    1,
  );
  expect(lock.success).toBe(true);
  const hubIsLeft = sourcePull.signedAmount > 0n;
  return {
    account,
    route: restingRoute,
    privateSeed: deriveCrossJurisdictionPrivateSeed(RUNTIME_SEED, restingRoute),
    hubIsLeft,
    payerIsLeft: !hubIsLeft,
    pullId: sourcePull.pullId,
    tokenId: sourcePull.tokenId,
  };
};

/** Route as it looks after fills up to `numerator/denominator` are committed. */
const withCommittedFill = (
  route: CrossJurisdictionSwapRoute,
  numerator: bigint,
  denominator: bigint,
  coarseRatio: number,
): CrossJurisdictionSwapRoute => ({
  ...route,
  status: 'partially_filled',
  fillSeq: 1,
  cumulativeFillRatio: coarseRatio,
  fillNumerator: numerator,
  fillDenominator: denominator,
  filledSourceAmount: (BigInt(route.source.amount) * numerator) / denominator,
  filledTargetAmount: (BigInt(route.target.amount) * numerator) / denominator,
});

/** Mimics what fill-ack commit (`syncSourcePullBinding`) does on each fill. */
const commitFillToPull = (fixture: Fixture, filledRoute: CrossJurisdictionSwapRoute): void => {
  const pull = fixture.account.state.pulls!.get(fixture.pullId)!;
  pull.crossJurisdiction = buildCommittedCrossJurisdictionPullBinding(filledRoute, 'source');
};

const revealTx = (fixture: Fixture, filledRoute: CrossJurisdictionSwapRoute, ratio: number): AccountTx => ({
  type: 'cross_pull_reveal',
  data: {
    pullId: fixture.pullId,
    binary: buildCrossJurisdictionPullReveal(filledRoute, ratio, fixture.privateSeed).binary,
  },
});

const holdOf = (fixture: Fixture): bigint => {
  const delta = fixture.account.state.deltas.get(fixture.tokenId)!;
  return fixture.payerIsLeft ? delta.leftHold : delta.rightHold;
};

const offdeltaOf = (fixture: Fixture): bigint =>
  fixture.account.state.deltas.get(fixture.tokenId)!.offdelta;

describe('cross_pull_reveal (pay-as-you-go restating)', () => {
  test('committed half fill settles increment, restates claimedRatio into ProofBody', async () => {
    const fixture = await makeSourceLegFixture('restate-half');
    const halfRoute = withCommittedFill(fixture.route, 1n, 2n, HALF_RATIO);
    commitFillToPull(fixture, halfRoute);
    const offdeltaBefore = offdeltaOf(fixture);
    expect(holdOf(fixture)).toBe(1_000n);

    const result = await applyAccountTx(
      fixture.account, revealTx(fixture, halfRoute, HALF_RATIO), fixture.hubIsLeft, 3_000, 2,
    );
    expect(result.success).toBe(true);

    // Payer paid exactly the committed exact increment; remainder stays held.
    const moved = offdeltaOf(fixture) - offdeltaBefore;
    expect(moved).toBe(fixture.payerIsLeft ? -500n : 500n);
    expect(holdOf(fixture)).toBe(500n);
    const pull = fixture.account.state.pulls!.get(fixture.pullId)!;
    expect(pull.claimedRatio).toBe(HALF_RATIO);
    expect(pull.claimedAmount).toBe(500n);

    // The settled level is now the on-chain transformer baseline: a forced
    // close with zero argument evidence keeps it (applyPull pays only above
    // claimedRatio), which is the whole point of restating.
    const proof = buildAccountProofBody(fixture.account, addr('dd'));
    const pulls = proof.runtimeProofBody.transformers[0]!.batch!.pulls;
    expect(pulls).toHaveLength(1);
    expect(pulls[0]!.claimedRatio).toBe(HALF_RATIO);
  });

  test('rejects wrong side, stale replay, uncommitted and mismatched ratios, expiry', async () => {
    const fixture = await makeSourceLegFixture('restate-guards');

    // No committed fill yet: binding has no filled amounts to settle.
    const zeroRoute = { ...fixture.route };
    const premature = await applyAccountTx(
      fixture.account, revealTx(fixture, withCommittedFill(zeroRoute, 1n, 2n, HALF_RATIO), HALF_RATIO),
      fixture.hubIsLeft, 3_000, 2,
    );
    expect(premature.success).toBe(false);
    expect(premature.error).toContain('committed');

    const halfRoute = withCommittedFill(fixture.route, 1n, 2n, HALF_RATIO);
    commitFillToPull(fixture, halfRoute);

    const wrongSide = await applyAccountTx(
      fixture.account, revealTx(fixture, halfRoute, HALF_RATIO), fixture.payerIsLeft, 3_000, 2,
    );
    expect(wrongSide.success).toBe(false);
    expect(wrongSide.error).toContain('Only the source Hub');

    // Binary level must equal the bilaterally committed level.
    const overReveal = await applyAccountTx(
      fixture.account, revealTx(fixture, halfRoute, 49_152), fixture.hubIsLeft, 3_000, 2,
    );
    expect(overReveal.success).toBe(false);
    expect(overReveal.error).toContain('ratio mismatch');

    const ok = await applyAccountTx(
      fixture.account, revealTx(fixture, halfRoute, HALF_RATIO), fixture.hubIsLeft, 3_000, 2,
    );
    expect(ok.success).toBe(true);

    // Crash/resend replay of the same level is a committed no-op.
    const holdBefore = holdOf(fixture);
    const replay = await applyAccountTx(
      fixture.account, revealTx(fixture, halfRoute, HALF_RATIO), fixture.hubIsLeft, 3_500, 2,
    );
    expect(replay.success).toBe(true);
    expect(holdOf(fixture)).toBe(holdBefore);

    // A later level cannot be settled after the reveal deadline.
    const fullRoute = withCommittedFill(fixture.route, 1n, 1n, FULL_RATIO);
    commitFillToPull(fixture, fullRoute);
    const late = await applyAccountTx(
      fixture.account, revealTx(fixture, fullRoute, FULL_RATIO), fixture.hubIsLeft, SOURCE_REVEAL_UNTIL + 1_001, 2,
    );
    expect(late.success).toBe(false);
    expect(late.error).toContain('deadline expired');
  });

  test('terminal close after reveal settles only the remainder', async () => {
    const fixture = await makeSourceLegFixture('restate-then-close');
    const halfRoute = withCommittedFill(fixture.route, 1n, 2n, HALF_RATIO);
    commitFillToPull(fixture, halfRoute);
    const offdeltaStart = offdeltaOf(fixture);
    expect((await applyAccountTx(
      fixture.account, revealTx(fixture, halfRoute, HALF_RATIO), fixture.hubIsLeft, 3_000, 2,
    )).success).toBe(true);

    const fullRoute = withCommittedFill(fixture.route, 1n, 1n, FULL_RATIO);
    commitFillToPull(fixture, fullRoute);
    const binary = buildCrossJurisdictionPullReveal(fullRoute, FULL_RATIO, fixture.privateSeed).binary;
    const close = await applyAccountTx(
      fixture.account,
      {
        type: 'cross_pull_close',
        data: {
          pullId: fixture.pullId,
          binary,
          proof: buildCrossJurisdictionCloseProof(fullRoute, binary),
        },
      },
      fixture.hubIsLeft,
      4_000,
      3,
    );
    expect(close.success).toBe(true);
    // Reveal moved 500, close must add exactly the remaining 500 — never the
    // full cumulative again (the claimedAmount baseline prevents double pay).
    const moved = offdeltaOf(fixture) - offdeltaStart;
    expect(moved).toBe(fixture.payerIsLeft ? -1_000n : 1_000n);
    expect(holdOf(fixture)).toBe(0n);
    expect(fixture.account.state.pulls!.has(fixture.pullId)).toBe(false);
  });

  test('pending reveal binary feeds dispute arguments before frame commit', async () => {
    const fixture = await makeSourceLegFixture('restate-dispute-args');
    const halfRoute = withCommittedFill(fixture.route, 1n, 2n, HALF_RATIO);
    commitFillToPull(fixture, halfRoute);

    const proof = buildAccountProofBody(fixture.account, addr('dd'));
    const snapshot = captureDisputeArgumentSnapshot(
      fixture.account, proof.proofBodyHash, 1, proof.proofBodyStruct,
    );
    storeDisputeArgumentSnapshot(fixture.account, snapshot);

    const tx = revealTx(fixture, halfRoute, HALF_RATIO);
    fixture.account.mempool.push(tx);
    const args = buildDisputeArgumentsFromSnapshot(
      fixture.account, proof.proofBodyHash, { secretsSide: 'none' }, [],
    );
    const binaryHex = (tx.data as { binary: string }).binary.slice(2).toLowerCase();
    const beneficiaryArgs = fixture.hubIsLeft ? args.leftArguments : args.rightArguments;
    expect(beneficiaryArgs.toLowerCase()).toContain(binaryHex);
  });
});

describe('cross_pull_expire (payer housekeeping)', () => {
  test('payer releases remainder only after expiry; beneficiary never', async () => {
    const fixture = await makeSourceLegFixture('expire-basic');

    const early = await applyAccountTx(
      fixture.account, { type: 'cross_pull_expire', data: { pullId: fixture.pullId } },
      fixture.payerIsLeft, SOURCE_REVEAL_UNTIL - 5_000, 2,
    );
    expect(early.success).toBe(false);
    expect(early.error).toContain('deadline not reached');

    const wrongSide = await applyAccountTx(
      fixture.account, { type: 'cross_pull_expire', data: { pullId: fixture.pullId } },
      fixture.hubIsLeft, SOURCE_REVEAL_UNTIL + 1_001, 2,
    );
    expect(wrongSide.success).toBe(false);
    expect(wrongSide.error).toContain('Only the payer');

    const expire = await applyAccountTx(
      fixture.account, { type: 'cross_pull_expire', data: { pullId: fixture.pullId } },
      fixture.payerIsLeft, SOURCE_REVEAL_UNTIL + 1_001, 2,
    );
    expect(expire.success).toBe(true);
    expect(holdOf(fixture)).toBe(0n);
    expect(fixture.account.state.pulls!.has(fixture.pullId)).toBe(false);

    // Racing an already-removed pull is a committed no-op, not a frame poison.
    const replay = await applyAccountTx(
      fixture.account, { type: 'cross_pull_expire', data: { pullId: fixture.pullId } },
      fixture.payerIsLeft, SOURCE_REVEAL_UNTIL + 2_001, 2,
    );
    expect(replay.success).toBe(true);
  });

  test('after a partial reveal, expiry releases only the unclaimed remainder', async () => {
    const fixture = await makeSourceLegFixture('expire-after-reveal');
    const halfRoute = withCommittedFill(fixture.route, 1n, 2n, HALF_RATIO);
    commitFillToPull(fixture, halfRoute);
    expect((await applyAccountTx(
      fixture.account, revealTx(fixture, halfRoute, HALF_RATIO), fixture.hubIsLeft, 3_000, 2,
    )).success).toBe(true);
    const offdeltaAfterReveal = offdeltaOf(fixture);

    const expire = await applyAccountTx(
      fixture.account, { type: 'cross_pull_expire', data: { pullId: fixture.pullId } },
      fixture.payerIsLeft, SOURCE_REVEAL_UNTIL + 1_001, 2,
    );
    expect(expire.success).toBe(true);
    // The settled half stays paid; only the 500 remainder hold is released.
    expect(offdeltaOf(fixture)).toBe(offdeltaAfterReveal);
    expect(holdOf(fixture)).toBe(0n);
  });
});

describe('incoming-frame deadline admission for new pull txs', () => {
  const frameWith = (fixture: Fixture, tx: AccountTx, byLeft: boolean, timestamp: number): AccountFrame => ({
    ...fixture.account.currentFrame,
    height: 2,
    timestamp,
    byLeft,
    accountTxs: [tx],
  });
  const contextAt = (entityTimestamp: number) => ({
    entityTimestamp,
    finalizedJHeight: 0,
    owningEntityIsHub: false,
    verifyHanko: async () => ({ valid: true, entityId: null }),
  });

  test('expire before LOCAL expiry and reveal after LOCAL expiry are violations', async () => {
    const fixture = await makeSourceLegFixture('deadline-admission');
    const halfRoute = withCommittedFill(fixture.route, 1n, 2n, HALF_RATIO);
    commitFillToPull(fixture, halfRoute);

    const expireTx: AccountTx = { type: 'cross_pull_expire', data: { pullId: fixture.pullId } };
    const prematureExpire = getIncomingAccountDeadlineViolation(
      fixture.account.state,
      frameWith(fixture, expireTx, fixture.payerIsLeft, SOURCE_REVEAL_UNTIL + 1_001),
      contextAt(SOURCE_REVEAL_UNTIL - 5_000),
    );
    expect(prematureExpire?.reason).toContain('CROSS_PULL_EXPIRE_BEFORE_LOCAL_EXPIRY');

    const lateReveal = getIncomingAccountDeadlineViolation(
      fixture.account.state,
      frameWith(fixture, revealTx(fixture, halfRoute, HALF_RATIO), fixture.hubIsLeft, 3_000),
      contextAt(SOURCE_REVEAL_UNTIL + 1_001),
    );
    expect(lateReveal?.reason).toContain('CROSS_PULL_CLAIM_AFTER_LOCAL_EXPIRY');

    // The happy path passes admission.
    const okReveal = getIncomingAccountDeadlineViolation(
      fixture.account.state,
      frameWith(fixture, revealTx(fixture, halfRoute, HALF_RATIO), fixture.hubIsLeft, 3_000),
      contextAt(3_000),
    );
    expect(okReveal).toBeUndefined();
  });
});
