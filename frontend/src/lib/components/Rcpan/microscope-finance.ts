import { deriveDelta } from '@xln/runtime/account/utils';
import type { Delta, DerivedDelta } from '@xln/runtime/types';
import {
  deriveDisputeTokenFinalization,
  type DisputeTokenFinalization,
} from '@xln/runtime/protocol/dispute/finalization';
import type { RcpanTimelineState } from './microscope-timeline';
import type { RcpanMicroscopeToken } from './microscope-tokens';

const BPS = 10_000n;

export type MicroscopeFinanceFrame = Readonly<{
  token: RcpanMicroscopeToken;
  signedDelta: bigint;
  displayDelta: Delta;
  derived: DerivedDelta;
  finalization: DisputeTokenFinalization;
  initial: Readonly<{ userReserve: bigint; hubReserve: bigint; collateral: bigint }>;
  current: Readonly<{ userReserve: bigint; hubReserve: bigint; collateral: bigint; debt: bigint }>;
  final: Readonly<{ userReserve: bigint; hubReserve: bigint; debt: bigint }>;
  /** Cumulative external reserve increase across completed/current rebalance requests. */
  externalTopUp: bigint;
  /** Reserve increase attributable only to the currently animated request. */
  externalRequestTopUp: bigint;
}>;

export type FcuanFinanceFrame = Readonly<{
  token: RcpanMicroscopeToken;
  signedDelta: bigint;
  displayDelta: Delta;
  derived: DerivedDelta;
  userReserve: bigint;
  hubReserve: bigint;
  unsecuredClaim: bigint;
}>;

function progressBps(progress: number): bigint {
  if (!Number.isFinite(progress) || progress < 0 || progress > 1) {
    throw new Error('RCPAN_FINANCE_INVALID: phaseProgress must be within 0..1');
  }
  return BigInt(Math.round(progress * Number(BPS)));
}

function visualLerp(from: bigint, to: bigint, progress: number): bigint {
  const step = progressBps(progress);
  return from + (to - from) * step / BPS;
}

function accountDelta(token: RcpanMicroscopeToken, collateral: bigint, offdelta: bigint): Delta {
  return {
    tokenId: token.tokenId,
    collateral,
    ondelta: 0n,
    offdelta,
    leftCreditLimit: token.grossAmount,
    rightCreditLimit: token.grossAmount,
    leftAllowance: 0n,
    rightAllowance: 0n,
  };
}

function scenarioHubReserve(token: RcpanMicroscopeToken, timeline: RcpanTimelineState): bigint {
  if (timeline.scenario.id !== 'debt-recovery') return token.hubReserve;
  const collateral = token.grossAmount * timeline.scenario.collateralBps / BPS;
  const shortfall = token.grossAmount - collateral;
  return shortfall * timeline.scenario.hubShortfallLiquidityBps / BPS;
}

function paidProgress(timeline: RcpanTimelineState): number {
  return timeline.phase === 'payment' ? timeline.phaseProgress : 1;
}

function isPostFinalization(timeline: RcpanTimelineState): boolean {
  return [
    'settled',
    'rebalance-request-1',
    'rebalance-request-2',
    'debt-enforcement',
    'repaid',
  ].includes(timeline.phase);
}

function settlementProgress(timeline: RcpanTimelineState): number {
  if (timeline.phase === 'finalizing') return timeline.phaseProgress;
  return isPostFinalization(timeline) ? 1 : 0;
}

function deriveCurrentReserves(
  timeline: RcpanTimelineState,
  initialUser: bigint,
  initialHub: bigint,
  finalization: DisputeTokenFinalization,
): Readonly<{
  userReserve: bigint;
  hubReserve: bigint;
  debt: bigint;
  topUp: bigint;
  requestTopUp: bigint;
}> {
  const settled = settlementProgress(timeline);
  let userReserve = visualLerp(initialUser, finalization.after.reserves.left, settled);
  let hubReserve = visualLerp(initialHub, finalization.after.reserves.right, settled);
  let debt = visualLerp(0n, finalization.newDebt.rightToLeft, settled);
  let topUp = 0n;

  const totalDebt = finalization.newDebt.rightToLeft;
  const firstRequest = totalDebt / 2n;
  const secondRequest = totalDebt - firstRequest;
  let requestTopUp = 0n;

  if (timeline.phase === 'rebalance-request-1') {
    requestTopUp = visualLerp(0n, firstRequest, timeline.phaseProgress);
    topUp = requestTopUp;
    hubReserve += topUp;
  } else if (timeline.phase === 'rebalance-request-2') {
    requestTopUp = visualLerp(0n, secondRequest, timeline.phaseProgress);
    topUp = firstRequest + requestTopUp;
    hubReserve += topUp;
  } else if (timeline.phase === 'debt-enforcement') {
    const paid = visualLerp(0n, totalDebt, timeline.phaseProgress);
    topUp = totalDebt;
    hubReserve += topUp - paid;
    userReserve += paid;
    debt -= paid;
  } else if (timeline.phase === 'repaid') {
    topUp = totalDebt;
    userReserve += totalDebt;
    debt = 0n;
  }
  return { userReserve, hubReserve, debt, topUp, requestTopUp };
}

export function deriveRcpanFinanceFrame(
  token: RcpanMicroscopeToken,
  timeline: RcpanTimelineState,
): MicroscopeFinanceFrame {
  const collateral = token.grossAmount * timeline.scenario.collateralBps / BPS;
  const hubReserve = scenarioHubReserve(token, timeline);
  const finalization = deriveDisputeTokenFinalization({
    tokenId: token.tokenId,
    leftReserve: token.userReserve,
    rightReserve: hubReserve,
    collateral,
    ondelta: 0n,
    offdelta: token.grossAmount,
  });
  const reserves = deriveCurrentReserves(
    timeline,
    token.userReserve,
    hubReserve,
    finalization,
  );
  const collateralNow = visualLerp(collateral, 0n, settlementProgress(timeline));
  const displayDelta = isPostFinalization(timeline)
    ? accountDelta(token, 0n, 0n)
    : accountDelta(token, collateralNow, visualLerp(0n, token.grossAmount, paidProgress(timeline)));

  return {
    token,
    signedDelta: token.grossAmount,
    displayDelta,
    derived: deriveDelta(displayDelta, true),
    finalization,
    initial: { userReserve: token.userReserve, hubReserve, collateral },
    current: {
      userReserve: reserves.userReserve,
      hubReserve: reserves.hubReserve,
      collateral: collateralNow,
      debt: reserves.debt,
    },
    final: {
      userReserve: finalization.after.reserves.left + finalization.newDebt.rightToLeft,
      hubReserve: finalization.after.reserves.right,
      debt: 0n,
    },
    externalTopUp: reserves.topUp,
    externalRequestTopUp: reserves.requestTopUp,
  };
}

export function deriveFcuanFinanceFrame(
  token: RcpanMicroscopeToken,
  timeline: RcpanTimelineState,
): FcuanFinanceFrame {
  const displayDelta = accountDelta(
    token,
    0n,
    visualLerp(0n, token.grossAmount, paidProgress(timeline)),
  );
  return {
    token,
    signedDelta: token.grossAmount,
    displayDelta,
    derived: deriveDelta(displayDelta, true),
    userReserve: token.userReserve,
    hubReserve: scenarioHubReserve(token, timeline),
    unsecuredClaim: displayDelta.offdelta,
  };
}
