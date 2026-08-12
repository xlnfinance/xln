import { resolveMicroscopePalette, type RcpanMicroscopeControls } from './microscope-playground';
import type { RcpanTimelineState } from './microscope-timeline';
import { microscopeTokens, formatUsdMicros, tokenAmountToUsdMicros } from './microscope-tokens';
import { deriveFcuanFinanceFrame, deriveRcpanFinanceFrame } from './microscope-finance';
import {
  buildMicroscopeLane,
  buildMicroscopeNode,
  type TokenReserveDisplayInput,
} from './microscope-display-utils';
import { buildFcuanCourt, buildRcpanCourt } from './microscope-court-model';
import type {
  MicroscopeAccountDisplay,
  MicroscopeCourtDisplay,
  MicroscopeDebtDisplay,
  MicroscopeExternalFlow,
  MicroscopeProofDisplay,
} from './microscope-visual-types';

export type RcpanMicroscopeSystemFrame = Readonly<{
  account: MicroscopeAccountDisplay;
  court: MicroscopeCourtDisplay;
  exposureUsdMicros: bigint;
}>;

export type RcpanMicroscopeComparisonFrame = Readonly<{
  timeline: RcpanTimelineState;
  fcuan: RcpanMicroscopeSystemFrame;
  rcpan: RcpanMicroscopeSystemFrame;
  metrics: Readonly<{
    grossUsdMicros: bigint;
    collateralUsdMicros: bigint;
    reservePaidUsdMicros: bigint;
    newDebtUsdMicros: bigint;
    debtUsdMicros: bigint;
    allTokensConserved: boolean;
  }>;
}>;

function totalTokenUsd(
  values: readonly Readonly<{ token: ReturnType<typeof microscopeTokens>[number]; amount: bigint }>[],
): bigint {
  return values.reduce(
    (sum, { token, amount }) => sum + tokenAmountToUsdMicros(token, amount),
    0n,
  );
}

function phaseAfterPayment(timeline: RcpanTimelineState): boolean {
  return timeline.phase !== 'payment';
}

function disputeActive(timeline: RcpanTimelineState): boolean {
  return ['dispute-open', 'challenge', 'finalizing'].includes(timeline.phase);
}

function rcpanProof(timeline: RcpanTimelineState): MicroscopeProofDisplay {
  if (timeline.phase === 'payment') {
    return { state: 'signed', label: 'Signing update', detail: 'User and H1 sign the same delta' };
  }
  if (timeline.phase === 'signed') {
    return { state: 'signed', label: 'Proof #42 on both sides', detail: 'Either party can carry this receipt' };
  }
  if (timeline.phase === 'dispute-open') {
    return { state: 'submitted', label: 'Proof #42 submitted', detail: 'User opened the dispute' };
  }
  if (timeline.phase === 'challenge') {
    return { state: 'challenged', label: 'Challenge window', detail: 'Only a newer co-signed proof can replace it' };
  }
  return { state: 'finalized', label: 'Proof #42 finalized', detail: 'The signed delta drove settlement' };
}

function rcpanCaption(timeline: RcpanTimelineState): string {
  if (timeline.phase === 'payment') return 'Payment changes the signed account; liquid reserves stay put.';
  if (timeline.phase === 'signed') return 'User and H1 now hold the same portable receipt.';
  if (disputeActive(timeline)) return 'User can take that receipt to programmable settlement.';
  if (timeline.phase === 'rebalance-request-1') return 'A first independent request increases H1 reserve; FIFO debt stays queued.';
  if (timeline.phase === 'rebalance-request-2') return 'A second independent request finishes funding H1 reserve; debt still waits for enforcement.';
  if (timeline.phase === 'debt-enforcement') return 'The queued FIFO debt is paid from H1 reserve.';
  if (timeline.phase === 'repaid') return 'Debt is zero and the recovered value is in User reserve.';
  return 'Collateral is gone from escrow and reappears in entity reserves.';
}

function hiddenFlow(color: string): MicroscopeExternalFlow {
  return {
    visible: false,
    target: 'right',
    sourceLabel: '—',
    actionLabel: '—',
    tokenSymbol: '—',
    amountLabel: '—',
    color,
  };
}

function rcpanDebt(
  timeline: RcpanTimelineState,
  debtUsdMicros: bigint,
): MicroscopeDebtDisplay {
  const repaid = timeline.phase === 'repaid';
  return {
    visible: debtUsdMicros > 0n || repaid,
    label: repaid ? 'FIFO debt cleared' : 'FIFO debt object',
    detail: repaid ? 'Paid by enforceDebts()' : 'Explicit, ordered, and payable from future H1 reserve',
    amountLabel: repaid ? '$0' : formatUsdMicros(debtUsdMicros),
    tone: repaid
      ? 'success'
      : ['rebalance-request-1', 'rebalance-request-2'].includes(timeline.phase)
        ? 'warning'
        : 'danger',
  };
}

function fcuanDebt(timeline: RcpanTimelineState, exposure: bigint): MicroscopeDebtDisplay {
  return {
    visible: phaseAfterPayment(timeline),
    label: 'Operator exposure',
    detail: 'No shared proof connects this claim to code-enforced reserves',
    amountLabel: formatUsdMicros(exposure),
    tone: 'danger',
  };
}

export function deriveRcpanMicroscopeFrame(
  timeline: RcpanTimelineState,
  controls: RcpanMicroscopeControls,
): RcpanMicroscopeComparisonFrame {
  const tokens = microscopeTokens(controls.tokenCount);
  const palette = resolveMicroscopePalette(controls);
  const rcpanFrames = tokens.map((token) => deriveRcpanFinanceFrame(token, timeline));
  const fcuanFrames = tokens.map((token) => deriveFcuanFinanceFrame(token, timeline));

  const grossUsdMicros = totalTokenUsd(tokens.map((token) => ({ token, amount: token.grossAmount })));
  const collateralUsdMicros = totalTokenUsd(rcpanFrames.map((frame) => ({ token: frame.token, amount: frame.initial.collateral })));
  const reservePaidUsdMicros = totalTokenUsd(rcpanFrames.map((frame) => ({ token: frame.token, amount: frame.finalization.reservePaid.rightToLeft })));
  const newDebtUsdMicros = totalTokenUsd(rcpanFrames.map((frame) => ({ token: frame.token, amount: frame.finalization.newDebt.rightToLeft })));
  const debtUsdMicros = totalTokenUsd(rcpanFrames.map((frame) => ({ token: frame.token, amount: frame.current.debt })));
  const fcuanExposure = totalTokenUsd(fcuanFrames.map((frame) => ({ token: frame.token, amount: frame.unsecuredClaim })));

  const rcpanUserReserves: readonly TokenReserveDisplayInput[] = rcpanFrames.map((frame) => ({ token: frame.token, amount: frame.current.userReserve }));
  const rcpanHubReserves: readonly TokenReserveDisplayInput[] = rcpanFrames.map((frame) => ({ token: frame.token, amount: frame.current.hubReserve }));
  const fcuanUserReserves: readonly TokenReserveDisplayInput[] = fcuanFrames.map((frame) => ({ token: frame.token, amount: frame.userReserve }));
  const fcuanHubReserves: readonly TokenReserveDisplayInput[] = fcuanFrames.map((frame) => ({ token: frame.token, amount: frame.hubReserve }));

  const requestTopUp = totalTokenUsd(rcpanFrames.map((frame) => ({
    token: frame.token,
    amount: frame.externalRequestTopUp,
  })));
  const rebalanceRequest = timeline.phase === 'rebalance-request-1'
    ? 1
    : timeline.phase === 'rebalance-request-2'
      ? 2
      : 0;
  const treasuryFlow: MicroscopeExternalFlow = rebalanceRequest > 0
    ? {
      visible: true,
      target: 'right',
      sourceLabel: `Rebalance #${rebalanceRequest}`,
      actionLabel: 'Increase H1 reserve',
      tokenSymbol: `request ${rebalanceRequest} of 2 · across ${tokens.length} asset${tokens.length === 1 ? '' : 's'}`,
      amountLabel: formatUsdMicros(requestTopUp),
      color: palette.court,
    }
    : hiddenFlow(palette.court);
  const enforceFlow: MicroscopeExternalFlow = timeline.phase === 'debt-enforcement'
    ? {
      visible: true,
      target: 'left',
      sourceLabel: 'enforceDebts()',
      actionLabel: 'Pay User FIFO',
      tokenSymbol: `across ${tokens.length} asset${tokens.length === 1 ? '' : 's'}`,
      amountLabel: formatUsdMicros(debtUsdMicros),
      color: palette.proof,
    }
    : hiddenFlow(palette.proof);

  const rcpanAccount: MicroscopeAccountDisplay = {
    title: 'User ↔ H1 · xln',
    caption: rcpanCaption(timeline),
    left: buildMicroscopeNode('01-user', 'User', 'LEFT · account participant', rcpanUserReserves, controls, palette.user, disputeActive(timeline)),
    right: buildMicroscopeNode('02-h1', 'H1', 'RIGHT · hub', rcpanHubReserves, controls, palette.hub),
    lanes: rcpanFrames.map((frame) => buildMicroscopeLane(
      frame.token,
      frame.derived,
      timeline,
      controls,
      timeline.phase === 'finalizing' ? 'settling' : frame.current.debt > 0n ? 'pending' : 'none',
    )),
    proof: rcpanProof(timeline),
    dispute: { active: disputeActive(timeline), initiator: 'left', label: 'User → EVM Court', timeoutLabel: 'Proof #42' },
    debt: rcpanDebt(timeline, debtUsdMicros),
    palette: { proof: palette.proof, danger: palette.danger },
    treasuryTopUp: treasuryFlow,
    enforceDebt: enforceFlow,
  };

  const fcuanAccount: MicroscopeAccountDisplay = {
    title: 'User ↔ H1 · FCUAN',
    caption: "H1's database is the balance. User has no executable receipt.",
    left: buildMicroscopeNode('01-user', 'User', 'Customer record', fcuanUserReserves, controls, palette.user, disputeActive(timeline)),
    right: buildMicroscopeNode('02-h1', 'H1', 'Ledger operator', fcuanHubReserves, controls, palette.hub),
    lanes: fcuanFrames.map((frame) => buildMicroscopeLane(frame.token, frame.derived, timeline, controls, 'pending')),
    proof: { state: 'missing', label: 'No shared proof', detail: 'Only H1 controls the account record' },
    dispute: { active: disputeActive(timeline), initiator: 'left', label: 'No executable path', timeoutLabel: 'External process' },
    debt: fcuanDebt(timeline, fcuanExposure),
    palette: { proof: palette.proof, danger: palette.danger },
    treasuryTopUp: hiddenFlow('var(--theme-danger, #ef4444)'),
    enforceDebt: hiddenFlow('var(--theme-danger, #ef4444)'),
  };

  return {
    timeline,
    fcuan: { account: fcuanAccount, court: buildFcuanCourt(fcuanFrames, timeline, controls), exposureUsdMicros: fcuanExposure },
    rcpan: { account: rcpanAccount, court: buildRcpanCourt(rcpanFrames, timeline, controls), exposureUsdMicros: debtUsdMicros },
    metrics: {
      grossUsdMicros,
      collateralUsdMicros,
      reservePaidUsdMicros,
      newDebtUsdMicros,
      debtUsdMicros,
      allTokensConserved: rcpanFrames.every((frame) => frame.finalization.conservation.conserved),
    },
  };
}
