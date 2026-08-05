/**
 * Payer-authored expiry of a cross-j pull, plus the ladder property that keeps
 * pull settlement single-shot.
 */
import { describe, expect, test } from 'bun:test';

import { applyAccountTx } from '../account/tx/apply';
import { getIncomingAccountDeadlineViolation } from '../account/consensus/deadline-policy';
import {
  buildHashLadderProof,
  decodeHashLadderBinary,
  encodeHashLadderPartialBinary,
  revealHashLadder,
  verifyHashLadderBinary,
} from '../protocol/htlc/hash-ladder';
import {
  buildCrossJurisdictionPullBinding,
  buildPreparedCrossJurisdictionRoute,
} from '../extensions/cross-j/index';
import type { AccountFrame, AccountReplica, AccountTx } from '../types/account';
import { entity, jref, makeAccount, makeJurisdiction } from './helpers/cross-j';

const NOW = 1_000;
// buildPreparedCrossJurisdictionRoute: sourceRevealUntil = expiresAt + 60s.
const EXPIRES_AT = 61_000;
const SOURCE_REVEAL_UNTIL = EXPIRES_AT + 60_000;

type Fixture = {
  account: AccountReplica;
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
  const route = {
    ...buildPreparedCrossJurisdictionRoute(
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
      { runtimeSeed: 'cross-pull-expire-test', sourceDisputeDelayMs: 5_000, now: NOW },
    ),
    status: 'resting' as const,
  };
  const account = makeAccount(sourceHub, sourceUser, eth);
  const sourcePull = route.sourcePull!;
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
        crossJurisdiction: buildCrossJurisdictionPullBinding(route, 'source'),
        crossJurisdictionRoute: route,
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
    hubIsLeft,
    payerIsLeft: !hubIsLeft,
    pullId: sourcePull.pullId,
    tokenId: sourcePull.tokenId,
  };
};

const holdOf = (fixture: Fixture): bigint => {
  const delta = fixture.account.state.deltas.get(fixture.tokenId)!;
  return fixture.payerIsLeft ? delta.leftHold : delta.rightHold;
};

const expireTx = (fixture: Fixture): AccountTx => ({
  type: 'cross_pull_expire',
  data: { pullId: fixture.pullId },
});

describe('cross_pull_expire (payer housekeeping)', () => {
  test('payer releases the hold only after expiry; beneficiary never; replay is a no-op', async () => {
    const fixture = await makeSourceLegFixture('expire-basic');
    const delta = fixture.account.state.deltas.get(fixture.tokenId)!;
    const offdeltaBefore = delta.offdelta;
    expect(holdOf(fixture)).toBe(1_000n);

    const early = await applyAccountTx(
      fixture.account, expireTx(fixture), fixture.payerIsLeft, SOURCE_REVEAL_UNTIL - 5_000, 2,
    );
    expect(early.success).toBe(false);
    expect(early.error).toContain('deadline not reached');

    const wrongSide = await applyAccountTx(
      fixture.account, expireTx(fixture), fixture.hubIsLeft, SOURCE_REVEAL_UNTIL + 1_001, 2,
    );
    expect(wrongSide.success).toBe(false);
    expect(wrongSide.error).toContain('Only the payer');

    const expire = await applyAccountTx(
      fixture.account, expireTx(fixture), fixture.payerIsLeft, SOURCE_REVEAL_UNTIL + 1_001, 2,
    );
    expect(expire.success).toBe(true);
    expect(holdOf(fixture)).toBe(0n);
    // Expiry is pure housekeeping: it frees capacity and never moves value.
    expect(fixture.account.state.deltas.get(fixture.tokenId)!.offdelta).toBe(offdeltaBefore);
    expect(fixture.account.state.pulls!.has(fixture.pullId)).toBe(false);

    const replay = await applyAccountTx(
      fixture.account, expireTx(fixture), fixture.payerIsLeft, SOURCE_REVEAL_UNTIL + 2_001, 2,
    );
    expect(replay.success).toBe(true);
  });

  test('incoming frame cannot expire a pull the local clock still sees as live', async () => {
    const fixture = await makeSourceLegFixture('expire-admission');
    const frame: AccountFrame = {
      ...fixture.account.currentFrame,
      height: 2,
      timestamp: SOURCE_REVEAL_UNTIL + 1_001,
      byLeft: fixture.payerIsLeft,
      accountTxs: [expireTx(fixture)],
    };
    const context = {
      finalizedJHeight: 0,
      owningEntityIsHub: false,
      verifyHanko: async () => ({ valid: true, entityId: null }),
    };

    const premature = getIncomingAccountDeadlineViolation(
      fixture.account.state, frame, { ...context, entityTimestamp: SOURCE_REVEAL_UNTIL - 5_000 },
    );
    expect(premature?.reason).toContain('CROSS_PULL_EXPIRE_BEFORE_LOCAL_EXPIRY');

    const allowed = getIncomingAccountDeadlineViolation(
      fixture.account.state, frame, { ...context, entityTimestamp: SOURCE_REVEAL_UNTIL + 1_001 },
    );
    expect(allowed).toBeUndefined();
  });
});

describe('hash ladder is single-shot per commitment', () => {
  /**
   * Why pull settlement must reveal exactly one level per ladder.
   *
   * A nibble reveal for digit d is H^(15-d)(base), so a higher digit is
   * strictly more powerful: any lower digit derives from it by hashing.
   * Ratios can rise while individual nibbles fall (0x0FFF -> 0x1000), so two
   * authorized reveals leave the observer holding the nibble-wise maximum of
   * both — up to 0x0FFF (6.25% of notional) above anything ever authorized.
   *
   * The dispute path has no defence: DeltaTransformer.verifiedPullFillRatio
   * checks only the ladder math against partialRoot, with no knowledge of the
   * committed fill level. Both legs of a cross-j order share one commitment,
   * so reveals on the source leg would arm this over-claim on the target leg.
   */
  test('two authorized reveals forge a higher ratio; one reveal forges nothing', () => {
    const proof = buildHashLadderProof('ladder-single-shot-test');
    const commitment = { fullHash: proof.fullHash, partialRoot: proof.partialRoot };
    const lower = 0x0fff;
    const higher = 0x1000;
    const forged = 0x1fff;

    const revealsLower = decodeHashLadderBinary(revealHashLadder(proof, lower).binary).reveals!;
    const revealsHigher = decodeHashLadderBinary(revealHashLadder(proof, higher).binary).reveals!;

    const combined = encodeHashLadderPartialBinary(forged, [
      revealsHigher[0]!, revealsLower[1]!, revealsLower[2]!, revealsLower[3]!,
    ]);
    expect(verifyHashLadderBinary(commitment, combined).fillRatio).toBe(forged);
    expect(forged).toBeGreaterThan(higher);

    const soloForge = encodeHashLadderPartialBinary(forged, revealsHigher);
    expect(() => verifyHashLadderBinary(commitment, soloForge)).toThrow();
  });
});
