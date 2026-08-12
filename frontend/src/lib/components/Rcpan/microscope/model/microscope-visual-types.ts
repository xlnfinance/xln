/** Renderer-only contracts. Financial state is derived before it reaches these types. */
import type {
  DeltaCapacityBarPresentation,
  DeltaParts,
  DeltaVisualScale,
} from '$lib/components/Entity/shared/delta-types';

export type MicroscopeSide = 'left' | 'right';
export type MicroscopeCourtPlacement = 'top' | 'bottom' | 'right';
export type MicroscopeFlowDirection = 'left-to-right' | 'right-to-left';
export type MicroscopePacketState = 'hidden' | 'parked' | 'moving' | 'arrived';
export type MicroscopeProofState = 'missing' | 'signed' | 'submitted' | 'challenged' | 'finalized';
export type MicroscopeCourtTone = 'idle' | 'active' | 'warning' | 'success' | 'danger';

export type MicroscopeNodeTokenReserve = Readonly<{
  tokenKey: string;
  symbol: string;
  color: string;
  amountLabel: string;
}>;

export type MicroscopeNodeDisplay = Readonly<{
  id: string;
  name: string;
  roleLabel: string;
  reserveLabel: string;
  reserveRadiusPx: number;
  reserveCaption: string;
  color: string;
  tokens: readonly MicroscopeNodeTokenReserve[];
  selected?: boolean;
}>;

export type MicroscopePaymentPacket = Readonly<{
  state: MicroscopePacketState;
  direction: MicroscopeFlowDirection;
  amountLabel: string;
  progressPercent: number;
  durationMs: number;
  delayMs: number;
}>;

export type MicroscopeTokenLane = Readonly<{
  tokenKey: string;
  symbol: string;
  color: string;
  derived: DeltaParts;
  visualScale: DeltaVisualScale | null;
  barPresentation: DeltaCapacityBarPresentation | null;
  pendingOutDebtMode: 'none' | 'pending' | 'settling';
  barLayout: 'center' | 'sides';
  barHeightPx: number;
  payment: MicroscopePaymentPacket;
}>;

export type MicroscopeProofDisplay = Readonly<{
  state: MicroscopeProofState;
  label: string;
  detail: string;
}>;

export type MicroscopeDisputeDisplay = Readonly<{
  active: boolean;
  initiator: MicroscopeSide;
  label: string;
  timeoutLabel: string;
}>;

export type MicroscopeDebtDisplay = Readonly<{
  visible: boolean;
  label: string;
  detail: string;
  amountLabel: string;
  tone: 'danger' | 'warning' | 'success';
}>;

export type MicroscopeExternalFlow = Readonly<{
  visible: boolean;
  target: MicroscopeSide;
  sourceLabel: string;
  actionLabel: string;
  tokenSymbol: string;
  amountLabel: string;
  color: string;
}>;

export type MicroscopeAccountDisplay = Readonly<{
  title: string;
  caption: string;
  left: MicroscopeNodeDisplay;
  right: MicroscopeNodeDisplay;
  lanes: readonly MicroscopeTokenLane[];
  proof: MicroscopeProofDisplay;
  dispute: MicroscopeDisputeDisplay;
  debt: MicroscopeDebtDisplay;
  palette: Readonly<{ proof: string; danger: string }>;
  treasuryTopUp: MicroscopeExternalFlow;
  enforceDebt: MicroscopeExternalFlow;
}>;

export type MicroscopeCourtPhaseDisplay = Readonly<{
  stepLabel: string;
  title: string;
  detail: string;
  progressLabel: string;
  tone: MicroscopeCourtTone;
}>;

export type MicroscopeCourtRow = Readonly<{
  tokenKey: string;
  tokenSymbol: string;
  tokenColor: string;
  leftReserveLabel: string;
  rightReserveLabel: string;
  collateralLabel: string;
  signedDeltaLabel: string;
  finalDeltaLabel: string;
  verdictLabel: string;
  tone: MicroscopeCourtTone;
}>;

export type MicroscopeCourtRequest = Readonly<{
  visible: boolean;
  initiator: MicroscopeSide;
  fromLabel: string;
  actionLabel: string;
  proofLabel: string;
  color: string;
  moving: boolean;
}>;

export type MicroscopeCourtDisplay = Readonly<{
  mode: 'programmable' | 'fixed-rail';
  courtLabel: string;
  machineLabel: string;
  leftLabel: string;
  rightLabel: string;
  color: string;
  phase: MicroscopeCourtPhaseDisplay;
  rows: readonly MicroscopeCourtRow[];
  request: MicroscopeCourtRequest;
  footerNote: string;
  footerSummary: string;
}>;
