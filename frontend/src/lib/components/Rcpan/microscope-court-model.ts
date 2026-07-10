import type { FcuanFinanceFrame, MicroscopeFinanceFrame } from './microscope-finance';
import { resolveMicroscopePalette, type RcpanMicroscopeControls } from './microscope-playground';
import type { RcpanMicroscopePhase, RcpanTimelineState } from './microscope-timeline';
import { formatSignedTokenValue, formatTokenValue } from './microscope-display-utils';
import type {
  MicroscopeCourtDisplay,
  MicroscopeCourtPhaseDisplay,
  MicroscopeCourtRow,
} from './microscope-visual-types';

type PhaseCopy = Readonly<{
  title: string;
  detail: string;
  tone: MicroscopeCourtPhaseDisplay['tone'];
}>;

const RCPAN_PHASE_COPY: Readonly<Record<RcpanMicroscopePhase, PhaseCopy>> = {
  payment: { title: 'Balance moves off-chain', detail: 'H1 pays User across every token lane.', tone: 'idle' },
  signed: { title: 'Both sides hold the receipt', detail: 'User and H1 co-sign the same account state.', tone: 'success' },
  'dispute-open': { title: 'User submits the proof', detail: 'The EVM court can now execute this account.', tone: 'active' },
  challenge: { title: 'Newest valid proof wins', detail: 'H1 may replace it only with a newer co-signed state.', tone: 'warning' },
  finalizing: { title: 'Code allocates every token', detail: 'Collateral first, liquid reserve next, explicit debt last.', tone: 'active' },
  settled: { title: 'Escrow is cleared into reserves', detail: 'Collateral leaves the account and node reserves update.', tone: 'success' },
  'treasury-topup': { title: 'Treasury restores H1 reserve', detail: 'A separate reserve top-up makes the queued debt payable.', tone: 'warning' },
  'debt-enforcement': { title: 'FIFO debt is enforced', detail: 'enforceDebts() moves available reserve to User.', tone: 'active' },
  repaid: { title: 'Debt is cleared', detail: 'User is paid; H1 has no hidden shortfall.', tone: 'success' },
};

const FCUAN_PHASE_COPY: Readonly<Record<RcpanMicroscopePhase, PhaseCopy>> = {
  payment: { title: 'H1 records a gross payment', detail: 'The balance exists inside the operator ledger.', tone: 'idle' },
  signed: { title: 'User receives no shared proof', detail: 'Only H1 can attest to its internal database.', tone: 'danger' },
  'dispute-open': { title: 'No executable account proof', detail: 'User cannot start a code-driven payout from this balance.', tone: 'danger' },
  challenge: { title: 'No cryptographic challenge path', detail: 'The dispute leaves the account system.', tone: 'danger' },
  finalizing: { title: 'No programmable allocation', detail: 'The fixed rail cannot split collateral and reserves.', tone: 'danger' },
  settled: { title: 'Exposure remains with H1', detail: 'The operator record did not become a reserve payout.', tone: 'danger' },
  'treasury-topup': { title: 'Treasury action is off-ledger', detail: 'No account-level debt object connects it to User.', tone: 'danger' },
  'debt-enforcement': { title: 'No enforceDebts() path', detail: 'Recovery depends on an external process.', tone: 'danger' },
  repaid: { title: 'No deterministic account recovery', detail: 'A later payment is not linked to this claim by code.', tone: 'danger' },
};

function phaseDisplay(
  timeline: RcpanTimelineState,
  system: 'rcpan' | 'fcuan',
): MicroscopeCourtPhaseDisplay {
  const copy = system === 'rcpan' ? RCPAN_PHASE_COPY[timeline.phase] : FCUAN_PHASE_COPY[timeline.phase];
  return {
    stepLabel: `${timeline.scenario.index.toString().padStart(2, '0')} · step ${timeline.phaseIndex + 1}/${timeline.scenario.phases.length}`,
    title: copy.title,
    detail: copy.detail,
    progressLabel: `${Math.round(timeline.phaseProgress * 100)}% · ${timeline.scenario.shortLabel}`,
    tone: copy.tone,
  };
}

function rcpanVerdict(frame: MicroscopeFinanceFrame, timeline: RcpanTimelineState): string {
  if (timeline.phase === 'payment') return 'Updating';
  if (timeline.phase === 'signed') return 'Executable proof';
  if (timeline.phase === 'dispute-open') return 'Proof submitted';
  if (timeline.phase === 'challenge') return 'Challenge window';
  if (timeline.phase === 'finalizing') return 'Allocating';
  if (timeline.phase === 'treasury-topup') return 'Reserve top-up';
  if (timeline.phase === 'debt-enforcement') return 'Paying FIFO debt';
  if (timeline.phase === 'repaid') return 'Debt cleared';
  return frame.current.debt > 0n ? 'Debt queued' : 'Paid to reserves';
}

function rowTone(frame: MicroscopeFinanceFrame, timeline: RcpanTimelineState): MicroscopeCourtRow['tone'] {
  if (timeline.phase === 'payment') return 'idle';
  if (timeline.phase === 'settled' && frame.current.debt > 0n) return 'danger';
  if (['challenge', 'treasury-topup'].includes(timeline.phase)) return 'warning';
  if (['signed', 'settled', 'repaid'].includes(timeline.phase)) return 'success';
  return 'active';
}

function rcpanRows(
  frames: readonly MicroscopeFinanceFrame[],
  timeline: RcpanTimelineState,
  controls: RcpanMicroscopeControls,
): readonly MicroscopeCourtRow[] {
  return frames.map((frame) => ({
    tokenKey: String(frame.token.tokenId),
    tokenSymbol: frame.token.symbol,
    tokenColor: frame.token.color,
    leftReserveLabel: controls.showAmounts ? formatTokenValue(frame.token, frame.current.userReserve) : 'Visible reserve',
    rightReserveLabel: controls.showAmounts ? formatTokenValue(frame.token, frame.current.hubReserve) : 'Visible reserve',
    collateralLabel: controls.showAmounts ? formatTokenValue(frame.token, frame.current.collateral) : 'Escrowed',
    signedDeltaLabel: timeline.phase === 'payment' ? 'Forming…' : formatSignedTokenValue(frame.token, frame.signedDelta),
    finalDeltaLabel: ['payment', 'signed'].includes(timeline.phase) ? '—' : formatSignedTokenValue(frame.token, frame.signedDelta),
    verdictLabel: rcpanVerdict(frame, timeline),
    tone: rowTone(frame, timeline),
  }));
}

function fcuanRows(
  frames: readonly FcuanFinanceFrame[],
  timeline: RcpanTimelineState,
  controls: RcpanMicroscopeControls,
): readonly MicroscopeCourtRow[] {
  const blocked = !['payment'].includes(timeline.phase);
  return frames.map((frame) => ({
    tokenKey: String(frame.token.tokenId),
    tokenSymbol: frame.token.symbol,
    tokenColor: frame.token.color,
    leftReserveLabel: controls.showAmounts ? formatTokenValue(frame.token, frame.userReserve) : 'Operator-held',
    rightReserveLabel: controls.showAmounts ? formatTokenValue(frame.token, frame.hubReserve) : 'Operator-held',
    collateralLabel: 'None',
    signedDeltaLabel: 'No shared proof',
    finalDeltaLabel: '—',
    verdictLabel: blocked ? 'Cannot execute' : 'Operator record',
    tone: blocked ? 'danger' : 'idle',
  }));
}

function request(
  timeline: RcpanTimelineState,
  programmable: boolean,
  color: string,
): MicroscopeCourtDisplay['request'] {
  const visible = ['dispute-open', 'challenge'].includes(timeline.phase);
  return {
    visible,
    initiator: 'left',
    fromLabel: 'User',
    actionLabel: programmable ? 'startDispute()' : 'no dispute API',
    proofLabel: programmable ? 'proof #42' : 'no proof',
    color,
    moving: timeline.phase === 'dispute-open',
  };
}

export function buildRcpanCourt(
  frames: readonly MicroscopeFinanceFrame[],
  timeline: RcpanTimelineState,
  controls: RcpanMicroscopeControls,
): MicroscopeCourtDisplay {
  const palette = resolveMicroscopePalette(controls);
  return {
    mode: 'programmable',
    courtLabel: 'EVM Court',
    machineLabel: 'Programmable Jurisdiction machine',
    leftLabel: 'User',
    rightLabel: 'H1',
    color: palette.court,
    phase: phaseDisplay(timeline, 'rcpan'),
    rows: rcpanRows(frames, timeline, controls),
    request: request(timeline, true, palette.court),
    footerNote: 'Co-signed proof accepted by programmable code',
    footerSummary: `${frames.length} token${frames.length === 1 ? '' : 's'} finalized independently`,
  };
}

export function buildFcuanCourt(
  frames: readonly FcuanFinanceFrame[],
  timeline: RcpanTimelineState,
  controls: RcpanMicroscopeControls,
): MicroscopeCourtDisplay {
  const palette = resolveMicroscopePalette(controls);
  return {
    mode: 'fixed-rail',
    courtLabel: 'RTGS Rail',
    machineLabel: 'Not programmable at Jurisdiction-machine level',
    leftLabel: 'User',
    rightLabel: 'H1',
    color: palette.danger,
    phase: phaseDisplay(timeline, 'fcuan'),
    rows: fcuanRows(frames, timeline, controls),
    request: request(timeline, false, palette.danger),
    footerNote: 'Direct gross payments only',
    footerSummary: 'No collateral · no executable account dispute',
  };
}
