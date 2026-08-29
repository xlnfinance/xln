import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { cloneMicroscopeControls, type RcpanMicroscopeControls, type RcpanScenarioId } from '../../../src/lib/components/Rcpan/microscope/model/microscope-playground';
import { deriveRcpanMicroscopeFrame } from '../../../src/lib/components/Rcpan/microscope/model/microscope-model';
import { deriveMicroscopeTimeline, phaseStartMs } from '../../../src/lib/components/Rcpan/microscope/model/microscope-timeline';
import { RCPAN_COMPARISON_ROWS, RCPAN_SYSTEMS, RCPAN_UPGRADES } from './rcpan-content';
import { RcpanSimulator } from './rcpan-simulator';
import { Arrow, SiteFooter, SiteShell } from './site-shell';

const createInitialControls = (): RcpanMicroscopeControls => ({
  ...cloneMicroscopeControls(),
  playing: !window.matchMedia('(prefers-reduced-motion: reduce)').matches,
});

function RcpanHero({ onPayment, onDispute }: Readonly<{ onPayment: () => void; onDispute: () => void }>) {
  return (
    <section className="rcpan-hero">
      <div className="rcpan-hero-copy">
        <p className="kicker">Reserve-credit provable accounts</p>
        <h1>A balance<br /><em>you can take<br />to court.</em></h1>
        <p>Both parties sign the same account. If cooperation stops, that receipt can settle through programmable jurisdiction code.</p>
        <div className="hero-actions">
          <button className="button-primary" type="button" onClick={onPayment}>Run a payment <Arrow /></button>
          <button className="button-secondary" type="button" onClick={onDispute}>Start a dispute <Arrow /></button>
        </div>
      </div>
      <div className="proof-poster" aria-label="Co-signed bilateral account proof">
        <div className="proof-stamp"><span>PROOF</span><strong>#42</strong></div>
        <header><span>XLN / ACCOUNT STATE</span><b>CO-SIGNED</b></header>
        <div className="proof-parties"><div><small>LEFT</small><strong>USER</strong></div><i>↔</i><div><small>RIGHT</small><strong>H1</strong></div></div>
        <div className="proof-delta"><span>OFF-CHAIN DELTA</span><strong>+$1.00M</strong></div>
        <div className="proof-formula">−C<sub>L</sub> ≤ Δ ≤ R + C<sub>R</sub></div>
        <footer><span>SIGNATURE / USER <b>VALID</b></span><span>SIGNATURE / H1 <b>VALID</b></span></footer>
      </div>
    </section>
  );
}

function UpgradeStrip() {
  return <section className="rcpan-upgrades" aria-label="The three xln account upgrades">{RCPAN_UPGRADES.map(([index, title, detail]) => <article key={index}><span>{index}</span><h2>{title}</h2><p>{detail}</p></article>)}</section>;
}

function ArchitectureComparison() {
  return (
    <section className="rcpan-comparison" aria-labelledby="rcpan-comparison-title">
      <header><p className="kicker">Architecture, in plain English</p><h2 id="rcpan-comparison-title">A different<br />kind of L2.</h2><p>Bank-style credit, payment-channel proofs, and programmable settlement in one bilateral account.</p></header>
      <div className="comparison-scroll">
        <div className="comparison-table" role="table" aria-label="xln compared with payment channels, rollups, and traditional settlement">
          <div className="comparison-row comparison-head" role="row"><div role="columnheader">What matters</div>{RCPAN_SYSTEMS.map((system) => <div className={system.id === 'xln' ? 'is-featured' : undefined} role="columnheader" key={system.id}><strong>{system.name}</strong><span>{system.caption}</span></div>)}</div>
          {RCPAN_COMPARISON_ROWS.map((row) => <div className="comparison-row" role="row" key={row.label}><div role="rowheader">{row.label}</div>{RCPAN_SYSTEMS.map((system) => <div className={system.id === 'xln' ? 'is-featured' : undefined} role="cell" key={system.id}><strong>{row.cells[system.id].lead}</strong><span>{row.cells[system.id].detail}</span></div>)}</div>)}
        </div>
      </div>
    </section>
  );
}

function RcpanFinale() {
  return <section className="rcpan-finale"><div><p className="kicker">Credit with proof</p><h2>Choose exposure.<br /><em>Keep the receipt.</em></h2></div><div><p>Credit above collateral remains counterparty risk. The difference is that limits, signed state, and settlement order stay explicit.</p><a className="callout-link" href="/install">Run the protocol <Arrow /></a></div></section>;
}

export function RcpanPage() {
  const [controls, setControls] = useState(createInitialControls);
  const [elapsedMs, setElapsedMs] = useState(0);
  const elapsedFloat = useRef(0);
  const controlsRef = useRef(controls);

  useEffect(() => { controlsRef.current = controls; }, [controls]);
  useEffect(() => {
    let animationFrame = 0;
    let previous = performance.now();
    let lastPaint = previous;
    const tick = (now: number): void => {
      const frameMs = Math.min(100, Math.max(0, now - previous));
      previous = now;
      if (controlsRef.current.playing) {
        elapsedFloat.current += frameMs * controlsRef.current.playbackSpeed;
        if (now - lastPaint >= 32) {
          lastPaint = now;
          setElapsedMs(Math.floor(elapsedFloat.current));
        }
      }
      animationFrame = window.requestAnimationFrame(tick);
    };
    animationFrame = window.requestAnimationFrame(tick);
    return () => window.cancelAnimationFrame(animationFrame);
  }, []);

  const timeline = useMemo(() => deriveMicroscopeTimeline(elapsedMs, controls.phaseDurationMs, controls.scenarioMode), [controls.phaseDurationMs, controls.scenarioMode, elapsedMs]);
  const frame = useMemo(() => deriveRcpanMicroscopeFrame(timeline, controls), [controls, timeline]);
  const setClock = useCallback((next: number): void => { elapsedFloat.current = next; setElapsedMs(Math.floor(next)); }, []);
  const selectScenario = useCallback((scenarioMode: RcpanScenarioId | 'auto'): void => { setControls((current) => ({ ...current, scenarioMode, playing: true })); setClock(0); }, [setClock]);
  const patchControls = useCallback((patch: Partial<RcpanMicroscopeControls>): void => { setControls((current) => ({ ...current, ...patch })); }, []);
  const jumpTo = useCallback((phase: 'payment' | 'dispute-open'): void => {
    setClock(phaseStartMs(timeline.scenario.id, phase, controls.phaseDurationMs, controls.scenarioMode));
    patchControls({ playing: true });
    document.getElementById('rcpan-microscope')?.scrollIntoView({ behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth', block: 'start' });
  }, [controls.phaseDurationMs, controls.scenarioMode, patchControls, setClock, timeline.scenario.id]);

  return (
    <SiteShell activeRoute="/rcpan">
      <main className="rcpan-page">
        <RcpanHero onPayment={() => jumpTo('payment')} onDispute={() => jumpTo('dispute-open')} />
        <UpgradeStrip />
        <RcpanSimulator controls={controls} frame={frame} timeline={timeline} onPatchControls={patchControls} onRestart={() => setClock(0)} onSelectScenario={selectScenario} />
        <ArchitectureComparison />
        <RcpanFinale />
      </main>
      <SiteFooter />
    </SiteShell>
  );
}
