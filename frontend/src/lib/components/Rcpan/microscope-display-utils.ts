import type { DerivedDelta } from '@xln/runtime/types';
import type { RcpanMicroscopeControls } from './microscope-playground';
import { resolveMicroscopeBarPresentation } from './microscope-playground';
import { microscopePhaseDurationMs, type RcpanTimelineState } from './microscope-timeline';
import {
  formatMicroscopeTokenAmount,
  formatUsdMicros,
  tokenAmountToUsdMicros,
  type RcpanMicroscopeToken,
} from './microscope-tokens';
import type {
  MicroscopeNodeDisplay,
  MicroscopePaymentPacket,
  MicroscopeTokenLane,
} from './microscope-visual-types';

export type TokenReserveDisplayInput = Readonly<{
  token: RcpanMicroscopeToken;
  amount: bigint;
}>;

const GRAPH_RESERVE_REFERENCE_USD = 500_000;
const GRAPH_RESERVE_EXPONENT = 0.6;
const GRAPH_MIN_SIZE = 0.5;
const GRAPH_MAX_SIZE = 2.7;

export function sumReserveUsdMicros(reserves: readonly TokenReserveDisplayInput[]): bigint {
  return reserves.reduce(
    (sum, { token, amount }) => sum + tokenAmountToUsdMicros(token, amount),
    0n,
  );
}

export function reserveRadiusPx(
  reserves: readonly TokenReserveDisplayInput[],
  nodeScale: number,
): number {
  if (!Number.isFinite(nodeScale) || nodeScale < 0.7 || nodeScale > 1.5) {
    throw new Error('RCPAN_DISPLAY_INVALID: nodeScale must be within 0.7..1.5');
  }
  const totalUsd = Number(sumReserveUsdMicros(reserves)) / 1_000_000;
  const graphSize = totalUsd <= 0
    ? 0.4
    : Math.min(
      GRAPH_MAX_SIZE,
      Math.max(
        GRAPH_MIN_SIZE,
        GRAPH_MIN_SIZE * Math.pow(Math.max(1, totalUsd / GRAPH_RESERVE_REFERENCE_USD), GRAPH_RESERVE_EXPONENT),
      ),
    );
  return Math.round((20 + graphSize * 24) * nodeScale * 10) / 10;
}

export function buildMicroscopeNode(
  id: string,
  name: string,
  roleLabel: string,
  reserves: readonly TokenReserveDisplayInput[],
  controls: RcpanMicroscopeControls,
  color: string,
  selected = false,
): MicroscopeNodeDisplay {
  const total = sumReserveUsdMicros(reserves);
  return {
    id,
    name,
    roleLabel,
    reserveLabel: controls.showAmounts ? formatUsdMicros(total) : 'Reserve',
    reserveRadiusPx: reserveRadiusPx(reserves, controls.nodeScale),
    reserveCaption: controls.showConservation ? 'Size follows liquid reserves' : 'Liquid reserves',
    color,
    tokens: controls.showTokenRings
      ? reserves.map(({ token, amount }) => ({
        tokenKey: String(token.tokenId),
        symbol: token.symbol,
        color: token.color,
        amountLabel: controls.showAmounts ? formatMicroscopeTokenAmount(token, amount, 2) : '•••',
      }))
      : [],
    selected,
  };
}

export function buildMicroscopeLane(
  token: RcpanMicroscopeToken,
  derived: DerivedDelta,
  timeline: RcpanTimelineState,
  controls: RcpanMicroscopeControls,
  pendingOutDebtMode: MicroscopeTokenLane['pendingOutDebtMode'],
): MicroscopeTokenLane {
  const paymentVisible = controls.showPaymentTrail
    && !['settled', 'treasury-topup', 'debt-enforcement', 'repaid'].includes(timeline.phase);
  if (!Number.isFinite(controls.packetMs) || controls.packetMs <= 0) {
    throw new Error('RCPAN_DISPLAY_INVALID: packetMs must be positive');
  }
  const delayMs = (token.tokenId - 1) * 90;
  const elapsedPaymentMs = timeline.phase === 'payment'
    ? timeline.phaseProgress * microscopePhaseDurationMs('payment', controls.phaseDurationMs)
    : controls.packetMs + delayMs;
  const packetProgress = Math.max(0, Math.min(1, (elapsedPaymentMs - delayMs) / controls.packetMs));
  const state: MicroscopePaymentPacket['state'] = !paymentVisible
    ? 'hidden'
    : timeline.phase === 'payment' && packetProgress < 1 ? 'moving' : 'arrived';
  return {
    tokenKey: String(token.tokenId),
    symbol: token.symbol,
    color: token.color,
    derived,
    visualScale: null,
    barPresentation: resolveMicroscopeBarPresentation(controls),
    pendingOutDebtMode,
    barLayout: controls.barLayout,
    barHeightPx: controls.barHeightPx,
    payment: {
      state,
      direction: 'right-to-left',
      amountLabel: controls.showAmounts
        ? formatMicroscopeTokenAmount(token, token.grossAmount, 2)
        : 'Payment',
      progressPercent: 98 - packetProgress * 96,
      durationMs: controls.packetMs,
      delayMs,
    },
  };
}

export function formatTokenValue(token: RcpanMicroscopeToken, value: bigint): string {
  const scale = 10n ** BigInt(token.decimals);
  const normalized = Number(value * 100n / scale) / 100;
  const amount = new Intl.NumberFormat('en-US', {
    notation: normalized >= 10_000 ? 'compact' : 'standard',
    maximumFractionDigits: 2,
  }).format(normalized);
  return `${amount} ${token.symbol}`;
}

export function formatSignedTokenValue(token: RcpanMicroscopeToken, value: bigint): string {
  const sign = value > 0n ? '+' : '';
  return `${sign}${formatMicroscopeTokenAmount(token, value, 2)}`;
}
