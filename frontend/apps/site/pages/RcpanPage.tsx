import { useEffect, useMemo, useState } from 'react';

import { cloneMicroscopeControls, type RcpanScenarioMode } from '$lib/components/Rcpan/microscope-playground';
import { deriveRcpanMicroscopeFrame } from '$lib/components/Rcpan/microscope-model';
import { deriveMicroscopeTimeline, RCPAN_SCENARIOS } from '$lib/components/Rcpan/microscope-timeline';
import { formatUsdMicros } from '$lib/components/Rcpan/microscope-tokens';

import './rcpan.css';

const controls = cloneMicroscopeControls();

const useClock = (playing: boolean, resetKey: string): number => {
  const [elapsed, setElapsed] = useState(0);
  useEffect(() => {
    setElapsed(0);
    if (!playing) return;
    const startedAt = performance.now();
    let frame = 0;
    const tick = (now: number): void => {
      setElapsed(Math.max(0, Math.floor(now - startedAt)));
      frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [playing, resetKey]);
  return elapsed;
};

const metricPercent = (value: bigint, total: bigint): number => total === 0n ? 0 : Number(value * 10_000n / total) / 100;

export default function RcpanPage() {
  const [mode, setMode] = useState<RcpanScenarioMode>('auto');
  const [playing, setPlaying] = useState(true);
  const [restartKey, setRestartKey] = useState(0);
  const elapsed = useClock(playing, `${mode}:${restartKey}`);
  const timeline = useMemo(() => deriveMicroscopeTimeline(elapsed, controls.phaseDurationMs, mode), [elapsed, mode]);
  const frame = useMemo(() => deriveRcpanMicroscopeFrame(timeline, controls), [timeline]);
  const portions = [
    ['Collateral', frame.metrics.collateralUsdMicros, 'collateral'],
    ['Hub reserve', frame.metrics.reservePaidUsdMicros, 'reserve'],
    ['Explicit debt', frame.metrics.newDebtUsdMicros, 'debt'],
  ] as const;

  return (
    <div className="react-rcpan">
      <section className="rcpan-hero-react">
        <div><p className="rcpan-kicker">Reserve-credit provable accounts</p><h1>Credit that can<br />prove its bounds.</h1><p>One bilateral account joins bank-scale credit with an executable, co-signed settlement receipt.</p></div>
        <div className="rcpan-invariant"><span>BILATERAL INVARIANT</span><strong>−C<sub>L</sub> ≤ Δ ≤ R + C<sub>R</sub></strong><p>Every account update is valid only inside the agreed credit and reserve capacity.</p></div>
      </section>

      <section className="upgrade-strip-react" aria-label="RCPAN account upgrades">
        <article><span>01</span><h2>Portable proof</h2><p>Both parties sign the same balance.</p></article>
        <article><span>02</span><h2>Visible protection</h2><p>Collateral, then reserve, then explicit debt.</p></article>
        <article><span>03</span><h2>Executable dispute</h2><p>Canonical account logic allocates every token.</p></article>
      </section>

      <section className="microscope-react" aria-labelledby="microscope-react-title">
        <header><div><p className="rcpan-kicker">Live deterministic model</p><h2 id="microscope-react-title">Watch ownership become enforceable.</h2><p>Same payment. Two account regimes. Only the guarantees change.</p></div><div className="phase-readout"><span>{timeline.phase.replaceAll('-', ' ')}</span><strong>{timeline.scenario.label}</strong><div><button type="button" onClick={() => setPlaying(value => !value)}>{playing ? 'Pause' : 'Play'}</button><button type="button" onClick={() => setRestartKey(value => value + 1)}>Restart</button></div></div></header>
        <nav className="scenario-tabs-react" aria-label="Settlement scenarios">
          <button type="button" className={mode === 'auto' ? 'active' : undefined} onClick={() => setMode('auto')}><strong>Auto tour</strong><span>All three cases</span></button>
          {RCPAN_SCENARIOS.map(scenario => <button type="button" className={mode === scenario.id ? 'active' : undefined} onClick={() => setMode(scenario.id)} key={scenario.id}><strong>{scenario.shortLabel}</strong><span>{scenario.label}</span></button>)}
        </nav>

        <div className="account-comparison-react">
          <article className="legacy-account"><span>FCUAN / operator ledger</span><h3>An IOU inside H1</h3><p>H1 records the claim. The user cannot execute that record independently.</p><div className="account-value"><small>operator-only exposure</small><strong>{formatUsdMicros(frame.fcuan.exposureUsdMicros)}</strong></div><div className="account-line"><i /><b>USER</b><em>claim</em><b>H1</b><i /></div><footer>{frame.fcuan.court.phase.detail}</footer></article>
          <article className="provable-account"><span>RCPAN / co-signed proof</span><h3>A receipt the user can execute</h3><p>Both sides sign. The settlement program allocates protection and explicit debt.</p><div className="account-value"><small>explicit debt now</small><strong>{formatUsdMicros(frame.rcpan.exposureUsdMicros)}</strong></div><div className="account-line"><i /><b>USER</b><em>signed Δ</em><b>H1</b><i /></div><footer>{frame.rcpan.court.phase.detail}</footer></article>
        </div>

        <section className="waterfall-react" aria-label="Current xln settlement waterfall">
          <header><div><span>Settlement waterfall</span><strong>{formatUsdMicros(frame.metrics.grossUsdMicros)} signed balance</strong></div><small>{frame.metrics.allTokensConserved ? '✓ Every token conserved' : 'CONSERVATION ERROR'}</small></header>
          <div className="waterfall-bar-react">{portions.map(([label, value, className]) => <i aria-label={label} className={className} style={{ width: `${metricPercent(value, frame.metrics.grossUsdMicros)}%` }} key={label} />)}</div>
          <div className="waterfall-legend-react">{portions.map(([label, value, className]) => <span key={label}><i className={className} /><b>{label}</b>{formatUsdMicros(value)}</span>)}</div>
        </section>
      </section>

      <section className="rcpan-close"><p className="rcpan-kicker">Canonical model, visible output</p><h2>No parallel formulas. The page renders the same pure account derivation used by xln.</h2><a href="https://github.com/xlnfinance/xln/blob/main/runtime/account/utils.ts" target="_blank" rel="noreferrer">Inspect account derivation ↗</a></section>
    </div>
  );
}
