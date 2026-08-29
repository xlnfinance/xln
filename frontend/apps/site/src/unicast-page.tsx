import { useCallback, useEffect, useRef, useState, type ChangeEvent, type CSSProperties } from 'react';

import { Arrow, SiteFooter, SiteShell } from './site-shell';
import {
  NETWORK_DEVICE_DEFINITIONS,
  deriveUnicastFrame,
  parseNetworkTps,
} from './unicast-model';
import { ComplexityPoster, NetworkComparison } from './unicast-visualization';

const RAMP_DURATION_MS = 60_000;

function ParticipantLedger() {
  return (
    <section className="participant-ledger" aria-label="Network participant capacity">
      {NETWORK_DEVICE_DEFINITIONS.map((device) => (
        <article key={device.type}>
          <span>{device.shortLabel}</span>
          <div><strong>{device.count} {device.label}</strong><small>~{device.capacityTps.toLocaleString()} TPS capacity</small></div>
        </article>
      ))}
    </section>
  );
}

type LoadControlsProps = Readonly<{
  tps: number;
  playing: boolean;
  onChange: (tps: number) => void;
  onToggle: () => void;
}>;

function LoadControls({ tps, playing, onChange, onToggle }: LoadControlsProps) {
  const progress = ((tps - 1) / 999) * 100;
  const changeTps = (event: ChangeEvent<HTMLInputElement>): void => onChange(parseNetworkTps(Number(event.currentTarget.value)));
  return (
    <div className="load-controls" style={{ '--load-progress': `${progress}%` } as CSSProperties}>
      <div><span>Network throughput</span><strong>{tps.toLocaleString()} <small>TPS</small></strong></div>
      <label><span>1</span><input aria-label="Network TPS" type="range" min="1" max="1000" step="1" value={tps} onChange={changeTps} /><span>1,000</span></label>
      <button type="button" onClick={onToggle}>{playing ? 'Pause ramp' : tps >= 1_000 ? 'Replay ramp' : 'Auto ramp'} <Arrow /></button>
    </div>
  );
}

function NetworkInsight({ tps }: Readonly<{ tps: number }>) {
  const { insight } = deriveUnicastFrame(tps);
  return <aside className={`network-insight tone-${insight.tone}`} aria-live="polite"><span>Current finding</span><strong>{insight.lead}</strong><p>{insight.detail}</p></aside>;
}

function UnicastTakeaway() {
  return (
    <section className="unicast-takeaway">
      <div><p className="kicker">Scale by routing, not replication</p><h2>The internet<br />already chose<br /><em>unicast.</em></h2></div>
      <div className="complexity-equations"><p><span>Broadcast load</span><strong>traffic × every node</strong></p><p><span>xln route load</span><strong>traffic × one path</strong></p><a className="callout-link" href="/install">Run the protocol <Arrow /></a></div>
    </section>
  );
}

export function UnicastPage() {
  const [tps, setTps] = useState(1);
  const [playing, setPlaying] = useState(false);
  const tpsRef = useRef(tps);
  const setNetworkTps = useCallback((value: number): void => { tpsRef.current = value; setTps(value); }, []);

  useEffect(() => {
    if (!playing) return undefined;
    let animationFrame = 0;
    let lastPaint = 0;
    const startTps = tpsRef.current;
    const startAt = performance.now();
    const tick = (now: number): void => {
      const nextTps = Math.min(1_000, Math.round(startTps + (((now - startAt) / RAMP_DURATION_MS) * 999)));
      if (now - lastPaint >= 50 || nextTps === 1_000) { lastPaint = now; setNetworkTps(nextTps); }
      if (nextTps >= 1_000) { setPlaying(false); return; }
      animationFrame = window.requestAnimationFrame(tick);
    };
    animationFrame = window.requestAnimationFrame(tick);
    return () => window.cancelAnimationFrame(animationFrame);
  }, [playing, setNetworkTps]);

  const toggleRamp = (): void => {
    if (playing) { setPlaying(false); return; }
    if (tpsRef.current >= 1_000) setNetworkTps(1);
    setPlaying(true);
  };
  const changeTps = (value: number): void => { setPlaying(false); setNetworkTps(value); };

  return (
    <SiteShell activeRoute="/unicast">
      <main className="unicast-page">
        <section className="unicast-hero"><div><p className="kicker">Routing is the scaling primitive</p><h1>Why broadcast<br /><em>dies at scale.</em></h1><p>Global replay turns ordinary traffic into a hardware requirement. Unicast keeps each payment on the route that needs it.</p><a className="button-primary" href="#network-lab">Stress the network <Arrow /></a></div><ComplexityPoster /></section>
        <ParticipantLedger />
        <section className="unicast-lab" id="network-lab" aria-labelledby="unicast-lab-title"><header><div><p className="kicker">Visual proof · 100 participants</p><h2 id="unicast-lab-title">Turn up<br /><em>the load.</em></h2></div><p>Move from one to one thousand transactions per second. The device mix is identical; only traffic scope changes.</p></header><LoadControls tps={tps} playing={playing} onChange={changeTps} onToggle={toggleRamp} /><NetworkInsight tps={tps} /><NetworkComparison tps={tps} /></section>
        <UnicastTakeaway />
      </main>
      <SiteFooter />
    </SiteShell>
  );
}
