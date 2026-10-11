/**
 * K1 wallet layer: what the wallet shows each side owns equals what the
 * dispute payout mirror pays it.
 *
 * Chain of evidence:
 *   wallet (deriveDelta + accountNetBalance, as ui/src/runtime/views.ts reads them)
 *     == deriveDisputeTokenFinalization (this file, >= 20,000 seeded states)
 *     == Depository finalization (jurisdictions/test/dispute/DisputeEntitlementParity.test.ts)
 *
 * Meaning of each side, from viewer V with peer P (Δ = ondelta + offdelta is LEFT's allocation):
 *   outCollateral  = V's collateral share, paid from collateral at finalization (secured).
 *   outPeerCredit  = what P owes V beyond collateral; paid from P's free reserve, the rest
 *                    becomes a FIFO debt row against P (the wallet's "risk").
 *   inOwnCredit    = what V owes P beyond collateral, symmetric.
 *   accountNetBalance = outCollateral + outPeerCredit − inOwnCredit = V's whole entitlement.
 * Unused credit, holds and allowances change capacity, never entitlement.
 */
import { describe, expect, test } from 'bun:test';
import * as fc from 'fast-check';

import { deriveDelta } from '../../../account/utils';
import type { Delta } from '../../../types/account';
import { deriveDisputeTokenFinalization, type DisputeTokenFinalization } from '../../../protocol/dispute/finalization';
import { INT512_MAX, INT512_MIN, UINT256_MAX } from '../../../protocol/boundary/integer-ranges';
import { accountNetBalance } from '../../../../frontend/src/lib/utils/ui/accountBalance';

const SEED = Number(process.env['XLN_ENTITLEMENT_WALLET_SEED'] ?? 2026_1011);
const RUNS = Number(process.env['XLN_ENTITLEMENT_WALLET_RUNS'] ?? 20_000);

type State = Readonly<{
  collateral: bigint;
  leftCreditLimit: bigint;
  rightCreditLimit: bigint;
  delta: bigint;
  ondelta: bigint;
  leftReserve: bigint;
  rightReserve: bigint;
  leftDebt: bigint;
  rightDebt: bigint;
  leftHold: bigint;
  rightHold: bigint;
  leftAllowance: bigint;
  rightAllowance: bigint;
}>;

const widthBounded = (maxBits: number): fc.Arbitrary<bigint> =>
  fc.integer({ min: 1, max: maxBits }).chain(bits => fc.bigInt({ min: 0n, max: (1n << BigInt(bits)) - 1n }));

const amount256 = fc.oneof(
  { weight: 2, arbitrary: fc.constantFrom(0n, 1n, UINT256_MAX - 1n, UINT256_MAX) },
  { weight: 3, arbitrary: fc.bigInt({ min: 0n, max: 1_000n }) },
  { weight: 5, arbitrary: widthBounded(256) },
);

/** Δ inside RCPAN (with its exact bounds) or anywhere outside it that int512 offdelta can express. */
const deltaFor = (collateral: bigint, leftLimit: bigint, rightLimit: bigint): fc.Arbitrary<bigint> => {
  const ceiling = collateral + rightLimit;
  return fc.oneof(
    { weight: 3, arbitrary: fc.constantFrom(-leftLimit, -1n, 0n, 1n, collateral - 1n, collateral, collateral + 1n, ceiling) },
    { weight: 5, arbitrary: fc.bigInt({ min: -leftLimit, max: ceiling }) },
    { weight: 1, arbitrary: widthBounded(509).map(extra => -leftLimit - 1n - extra) },
    { weight: 1, arbitrary: widthBounded(509).map(extra => ceiling + 1n + extra) },
  );
};

const stateArb: fc.Arbitrary<State> = fc
  .tuple(amount256, amount256, amount256)
  .chain(([collateral, leftCreditLimit, rightCreditLimit]) => {
    const room = UINT256_MAX - collateral;
    return fc.record({
      collateral: fc.constant(collateral),
      leftCreditLimit: fc.constant(leftCreditLimit),
      rightCreditLimit: fc.constant(rightCreditLimit),
      delta: deltaFor(collateral, leftCreditLimit, rightCreditLimit),
      // Cooperative settlements can move ondelta far from collateral; reachable
      // allocation stays below 2^310 (docs/money-domain.md).
      ondelta: fc.oneof(fc.constant(0n), fc.constant(collateral), fc.bigInt({ min: -(1n << 310n), max: 1n << 310n })),
      // Custody of one token never exceeds uint256: both reserves fit beside collateral.
      leftReserve: fc.bigInt({ min: 0n, max: room / 2n }),
      rightReserve: fc.bigInt({ min: 0n, max: room / 2n }),
      leftDebt: fc.oneof(fc.constant(0n), amount256, widthBounded(600)),
      rightDebt: fc.oneof(fc.constant(0n), amount256, widthBounded(600)),
      leftHold: amount256,
      rightHold: amount256,
      leftAllowance: amount256,
      rightAllowance: amount256,
    });
  });

const accountDelta = (state: State): Delta => ({
  tokenId: 1,
  collateral: state.collateral,
  ondelta: state.ondelta,
  offdelta: state.delta - state.ondelta,
  leftCreditLimit: state.leftCreditLimit,
  rightCreditLimit: state.rightCreditLimit,
  leftAllowance: state.leftAllowance,
  rightAllowance: state.rightAllowance,
  leftHold: state.leftHold,
  rightHold: state.rightHold,
});

const payout = (state: State): DisputeTokenFinalization => {
  const delta = accountDelta(state);
  return deriveDisputeTokenFinalization({
    tokenId: 1,
    leftReserve: state.leftReserve,
    rightReserve: state.rightReserve,
    collateral: state.collateral,
    ondelta: delta.ondelta,
    offdelta: delta.offdelta,
    existingDebtOutstanding: { left: state.leftDebt, right: state.rightDebt },
  });
};

type Side = 'left' | 'right';
const flows = (result: DisputeTokenFinalization, side: Side) => {
  const toSide = side === 'left' ? 'rightToLeft' : 'leftToRight';
  const fromSide = side === 'left' ? 'leftToRight' : 'rightToLeft';
  return {
    received: result.reservePaid[toSide] + result.newDebt[toSide],
    paidNow: result.reservePaid[toSide],
    given: result.reservePaid[fromSide] + result.newDebt[fromSide],
    owedByPeer: result.shortfall[toSide],
    owedToPeer: result.shortfall[fromSide],
  };
};

/** Wallet surfaces for one viewer, exactly as views.ts splits a positive position. */
const assertWalletSide = (state: State, result: DisputeTokenFinalization, side: Side): bigint => {
  const view = deriveDelta(accountDelta(state), side === 'left');
  const peer: Side = side === 'left' ? 'right' : 'left';
  const flow = flows(result, side);
  expect(view.outCollateral).toBe(result.collateralAllocation[side]);
  expect(view.inCollateral).toBe(result.collateralAllocation[peer]);
  expect(view.outPeerCredit).toBe(flow.owedByPeer);
  expect(view.inOwnCredit).toBe(flow.owedToPeer);
  const net = accountNetBalance(view);
  expect(net).toBe(result.collateralAllocation[side] + flow.received - flow.given);
  if (net > 0n) {
    const risk = view.outPeerCredit < net ? view.outPeerCredit : net;
    expect(net - risk).toBe(result.collateralAllocation[side]);
    expect(risk).toBe(flow.received);
  }
  const peerReserve = result.before.reserves[peer];
  const peerDebt = result.before.debtOutstanding[peer];
  expect(flow.paidNow <= (peerReserve > peerDebt ? peerReserve - peerDebt : 0n)).toBe(true);
  return net;
};

const assertEntitlement = (state: State): void => {
  const result = payout(state);
  const leftNet = assertWalletSide(state, result, 'left');
  const rightNet = assertWalletSide(state, result, 'right');
  expect(leftNet).toBe(state.delta);
  expect(leftNet + rightNet).toBe(state.collateral);
  expect(result.conservation.conserved).toBe(true);
  expect(result.after.debtOutstanding.left).toBe(state.leftDebt + result.newDebt.leftToRight);
  expect(result.after.debtOutstanding.right).toBe(state.rightDebt + result.newDebt.rightToLeft);
  if (state.delta >= -state.leftCreditLimit && state.delta <= state.collateral + state.rightCreditLimit) {
    // RCPAN: nobody can end up owing more than the credit the other side extended.
    expect(result.shortfall.leftToRight <= state.leftCreditLimit).toBe(true);
    expect(result.shortfall.rightToLeft <= state.rightCreditLimit).toBe(true);
  }
};

describe('dispute entitlement: wallet view == payout mirror', () => {
  test(`fast-check: ${RUNS} seeded single-token states (seed ${SEED})`, () => {
    let insideRcpan = 0;
    let shortfallStates = 0;
    fc.assert(
      fc.property(stateArb, state => {
        expect(state.delta - state.ondelta >= INT512_MIN && state.delta - state.ondelta <= INT512_MAX).toBe(true);
        assertEntitlement(state);
        if (state.delta >= -state.leftCreditLimit && state.delta <= state.collateral + state.rightCreditLimit) insideRcpan++;
        if (state.delta < 0n || state.delta > state.collateral) shortfallStates++;
      }),
      { seed: SEED, numRuns: RUNS },
    );
    console.log(`[entitlement-wallet] seed=${SEED} runs=${RUNS} insideRcpan=${insideRcpan} shortfall=${shortfallStates}`);
    expect(insideRcpan).toBeGreaterThan(RUNS / 2);
    expect(shortfallStates).toBeGreaterThan(RUNS / 10);
  });

  test('holds, allowances and unused credit never change entitlement', () => {
    const base: State = {
      collateral: 100n, leftCreditLimit: 0n, rightCreditLimit: 0n, delta: 25n, ondelta: 0n,
      leftReserve: 0n, rightReserve: 0n, leftDebt: 0n, rightDebt: 0n,
      leftHold: 0n, rightHold: 0n, leftAllowance: 0n, rightAllowance: 0n,
    };
    const busy: State = { ...base, leftCreditLimit: 1_000n, rightCreditLimit: 2_000n, leftHold: 20n, rightHold: 30n, leftAllowance: 5n, rightAllowance: 7n };
    for (const state of [base, busy]) {
      expect(accountNetBalance(deriveDelta(accountDelta(state), true))).toBe(25n);
      expect(accountNetBalance(deriveDelta(accountDelta(state), false))).toBe(75n);
      expect(payout(state).collateralAllocation).toEqual({ left: 25n, right: 75n });
    }
  });
});
