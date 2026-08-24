import type { CSSProperties, ChangeEvent } from 'react';

import type { RcpanMicroscopeComparisonFrame, RcpanMicroscopeSystemFrame } from '../../../src/lib/components/Rcpan/microscope/model/microscope-model';
import type { RcpanMicroscopeControls, RcpanScenarioId } from '../../../src/lib/components/Rcpan/microscope/model/microscope-playground';
import { RCPAN_SCENARIOS, type RcpanTimelineState } from '../../../src/lib/components/Rcpan/microscope/model/microscope-timeline';
import { formatUsdMicros } from '../../../src/lib/components/Rcpan/microscope/model/microscope-tokens';
import type { MicroscopeAccountDisplay, MicroscopeCourtDisplay, MicroscopeNodeDisplay, MicroscopeTokenLane } from '../../../src/lib/components/Rcpan/microscope/model/microscope-visual-types';

type SimulatorProps = Readonly<{
  controls: RcpanMicroscopeControls;
  frame: RcpanMicroscopeComparisonFrame;
  timeline: RcpanTimelineState;
  onPatchControls: (patch: Partial<RcpanMicroscopeControls>) => void;
  onRestart: () => void;
  onSelectScenario: (scenario: RcpanScenarioId | 'auto') => void;
}>;

const percentOf = (value: bigint, total: bigint): number => total === 0n ? 0 : Number(value * 10_000n / total) / 100;

function ActorNode({ node }: Readonly<{ node: MicroscopeNodeDisplay }>) {
  return (
    <article className={node.selected ? 'evidence-node is-selected' : 'evidence-node'} style={{ '--node-color': node.color } as CSSProperties}>
      <div className="node-orbit" style={{ width: `${node.reserveRadiusPx * 1.35}px`, height: `${node.reserveRadiusPx * 1.35}px` }}><span>Reserve</span><strong>{node.reserveLabel}</strong></div>
      <div><b>{node.name}</b><span>{node.roleLabel}</span><small>{node.reserveCaption}</small></div>
      <footer>{node.tokens.map((token) => <span key={token.tokenKey} style={{ '--token-color': token.color } as CSSProperties}><i />{token.symbol} <b>{token.amountLabel}</b></span>)}</footer>
    </article>
  );
}

function DeltaBar({ lane }: Readonly<{ lane: MicroscopeTokenLane }>) {
  const parts = lane.derived;
  const outTotal = parts.outOwnCredit + parts.outCollateral + parts.outPeerCredit;
  const inTotal = parts.inOwnCredit + parts.inCollateral + parts.inPeerCredit;
  const scale = outTotal > inTotal ? outTotal : inTotal;
  const style = { '--bar-height': `${lane.barHeightPx}px`, '--token-color': lane.color } as CSSProperties;
  return (
    <div className="evidence-lane" style={style}>
      <span className="lane-token"><i />{lane.symbol}</span>
      <div className="delta-bar">
        <div className="delta-half out"><i className="credit" style={{ width: `${percentOf(parts.outOwnCredit, scale)}%` }} /><i className="collateral" style={{ width: `${percentOf(parts.outCollateral, scale)}%` }} /><i className="debt" style={{ width: `${percentOf(parts.outPeerCredit, scale)}%` }} /></div>
        <b className="delta-axis" />
        <div className="delta-half in"><i className="debt" style={{ width: `${percentOf(parts.inOwnCredit, scale)}%` }} /><i className="collateral" style={{ width: `${percentOf(parts.inCollateral, scale)}%` }} /><i className="credit" style={{ width: `${percentOf(parts.inPeerCredit, scale)}%` }} /></div>
        {lane.payment.state !== 'hidden' ? <span className={`payment-packet ${lane.payment.state}`} style={{ left: `${lane.payment.progressPercent}%` }}>{lane.payment.amountLabel}</span> : null}
      </div>
    </div>
  );
}

function CourtLedger({ court }: Readonly<{ court: MicroscopeCourtDisplay }>) {
  if (court.rows.length < 1 || court.rows.length > 4) throw new Error('RCPAN_REACT_COURT_ROWS_INVALID');
  return (
    <section className={`evidence-court tone-${court.phase.tone}`} style={{ '--court-color': court.color } as CSSProperties} aria-label={court.courtLabel}>
      {court.request.visible ? <div className="court-request"><span>{court.request.fromLabel}</span><i /><strong>{court.request.proofLabel}</strong><b>{court.request.actionLabel}</b></div> : null}
      <header><div><span>{court.courtLabel}</span><small>{court.machineLabel}</small></div><div><b>{court.phase.title}</b><span>{court.phase.detail}</span></div><strong>{court.phase.progressLabel}</strong></header>
      <div className="court-table" role="table">
        {court.rows.map((row) => <div className="court-row" role="row" key={row.tokenKey}><span role="cell" style={{ '--token-color': row.tokenColor } as CSSProperties}><i />{row.tokenSymbol}</span><span role="cell"><small>Collateral</small>{row.collateralLabel}</span><span role="cell"><small>Signed Δ</small>{row.signedDeltaLabel}</span><strong role="cell">{row.verdictLabel}</strong></div>)}
      </div>
      <footer><span>{court.footerNote}</span><strong>{court.footerSummary}</strong></footer>
    </section>
  );
}

function AccountEvidence({ account }: Readonly<{ account: MicroscopeAccountDisplay }>) {
  if (account.lanes.length < 1 || account.lanes.length > 4) throw new Error('RCPAN_REACT_ACCOUNT_LANES_INVALID');
  return (
    <section className={`account-evidence proof-${account.proof.state}`} aria-label={account.title}>
      <header><div><span>Live account microscope</span><h4>{account.title}</h4></div><p>{account.caption}</p></header>
      {account.treasuryTopUp.visible ? <div className="external-flow">{account.treasuryTopUp.sourceLabel} <i>→</i> <strong>{account.treasuryTopUp.amountLabel}</strong> {account.treasuryTopUp.actionLabel}</div> : null}
      <div className="evidence-stage">
        <ActorNode node={account.left} />
        <div className="evidence-corridor">
          <div className="proof-state"><span>{account.proof.state === 'missing' ? '×' : '✓'}</span><div><b>{account.proof.label}</b><small>{account.proof.detail}</small></div></div>
          <div className="evidence-lanes">{account.lanes.map((lane) => <DeltaBar key={lane.tokenKey} lane={lane} />)}</div>
          {account.dispute.active ? <div className="dispute-state"><span>Dispute</span><b>{account.dispute.label}</b><small>{account.dispute.timeoutLabel}</small></div> : null}
          {account.debt.visible ? <div className={`debt-state tone-${account.debt.tone}`}><span>{account.debt.label}</span><b>{account.debt.amountLabel}</b><small>{account.debt.detail}</small></div> : null}
        </div>
        <ActorNode node={account.right} />
      </div>
      {account.enforceDebt.visible ? <div className="external-flow is-enforcement">{account.enforceDebt.sourceLabel} <i>→</i> <strong>{account.enforceDebt.amountLabel}</strong> {account.enforceDebt.actionLabel}</div> : null}
    </section>
  );
}

function SystemPanel({ label, title, summary, exposureLabel, system, tone }: Readonly<{ label: string; title: string; summary: string; exposureLabel: string; system: RcpanMicroscopeSystemFrame; tone: 'fcuan' | 'rcpan' }>) {
  return (
    <article className={`system-panel is-${tone}`}>
      <header><div><span>{label}</span><h3>{title}</h3><p>{summary}</p></div><div><small>{exposureLabel}</small><strong>{formatUsdMicros(system.exposureUsdMicros)}</strong></div></header>
      <CourtLedger court={system.court} />
      <AccountEvidence account={system.account} />
    </article>
  );
}

function ScenarioControls({ controls, timeline, onPatchControls, onRestart, onSelectScenario }: Omit<SimulatorProps, 'frame'>) {
  const changeNumber = (key: 'tokenCount' | 'phaseDurationMs' | 'playbackSpeed') => (event: ChangeEvent<HTMLSelectElement>): void => onPatchControls({ [key]: Number(event.currentTarget.value) });
  return (
    <div className="scenario-console">
      <div className="scenario-status"><span><i />{timeline.phase.replaceAll('-', ' ')}</span><strong>{timeline.scenario.label}</strong><small>step {timeline.phaseIndex + 1}/{timeline.scenario.phases.length}</small></div>
      <nav aria-label="Dispute settlement scenarios"><button className={controls.scenarioMode === 'auto' ? 'is-active' : undefined} type="button" onClick={() => onSelectScenario('auto')}><span>Auto tour</span><small>All three cases</small></button>{RCPAN_SCENARIOS.map((scenario) => <button className={controls.scenarioMode === scenario.id ? 'is-active' : undefined} type="button" key={scenario.id} onClick={() => onSelectScenario(scenario.id)}><span>{scenario.shortLabel}</span><small>{scenario.label}</small></button>)}</nav>
      <div className="scenario-actions"><button type="button" onClick={() => onPatchControls({ playing: !controls.playing })}>{controls.playing ? 'Pause' : 'Play'}</button><button type="button" onClick={onRestart}>Restart</button><label>Assets<select value={controls.tokenCount} onChange={changeNumber('tokenCount')}><option value="1">1 · USDC</option><option value="2">2 · + WETH</option><option value="3">3 · + USDT</option><option value="4">4 · + TRX</option></select></label><label>Speed<select value={controls.playbackSpeed} onChange={changeNumber('playbackSpeed')}><option value="0.5">0.5×</option><option value="1">1×</option><option value="2">2×</option><option value="3">3×</option></select></label><label>Phase<select value={controls.phaseDurationMs} onChange={changeNumber('phaseDurationMs')}><option value="900">0.9s</option><option value="1550">1.55s</option><option value="2500">2.5s</option></select></label></div>
    </div>
  );
}

function SettlementWaterfall({ frame }: Readonly<{ frame: RcpanMicroscopeComparisonFrame }>) {
  const total = frame.metrics.grossUsdMicros;
  return (
    <section className="settlement-waterfall" aria-label="Current xln settlement waterfall"><header><div><span>Initial settlement waterfall</span><strong>{formatUsdMicros(total)} signed balance</strong></div><small>{frame.metrics.allTokensConserved ? '✓ Every token conserved during finalization' : 'Conservation error'}</small></header><div className="waterfall-track"><i className="collateral" style={{ width: `${percentOf(frame.metrics.collateralUsdMicros, total)}%` }} /><i className="reserve" style={{ width: `${percentOf(frame.metrics.reservePaidUsdMicros, total)}%` }} /><i className="debt" style={{ width: `${percentOf(frame.metrics.newDebtUsdMicros, total)}%` }} /></div><footer><span><i className="collateral" />Collateral <b>{formatUsdMicros(frame.metrics.collateralUsdMicros)}</b></span><span><i className="reserve" />H1 reserve <b>{formatUsdMicros(frame.metrics.reservePaidUsdMicros)}</b></span><span><i className="debt" />Debt created <b>{formatUsdMicros(frame.metrics.newDebtUsdMicros)}</b></span></footer></section>
  );
}

export function RcpanSimulator(props: SimulatorProps) {
  return (
    <section className="rcpan-simulator" id="rcpan-microscope" aria-labelledby="rcpan-simulator-title">
      <header className="simulator-heading"><div><p className="kicker">One payment · two account regimes</p><h2 id="rcpan-simulator-title">Watch ownership<br /><em>become enforceable.</em></h2></div><p>Same User, same H1, same payment. Only the guarantees change.</p></header>
      <ScenarioControls {...props} />
      <div className="system-panels"><SystemPanel label="FCUAN · today" title="An IOU inside H1" summary="H1's record says what User owns. User cannot execute that record." exposureLabel="operator-only claim" system={props.frame.fcuan} tone="fcuan" /><SystemPanel label="xln · RCPAN" title="A receipt User can execute" summary="Both sides sign. Code allocates protection and updates reserves." exposureLabel="explicit debt now" system={props.frame.rcpan} tone="rcpan" /></div>
      <SettlementWaterfall frame={props.frame} />
    </section>
  );
}
