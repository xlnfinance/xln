import { Arrow, LaunchLink, SiteFooter, SiteShell } from './site-shell';

const PROPERTIES = [
  ['01', 'Unicast', 'Counterparties update the path that matters—not a planet-wide broadcast ledger.'],
  ['02', 'Provable', 'Signed bilateral state remains mechanically enforceable against collateral.'],
  ['03', 'Local', 'Live financial state belongs with its participants, not a global sequencer.'],
] as const;

function NetworkField() {
  return (
    <div className="network-field" aria-label="Three local financial networks connected by bilateral unicast paths">
      <div className="network-orbit orbit-one" aria-hidden="true" />
      <div className="network-orbit orbit-two" aria-hidden="true" />
      <div className="network-node node-a"><span>A</span><small>LOCAL</small></div>
      <div className="network-node node-b"><span>B</span><small>LOCAL</small></div>
      <div className="network-node node-c"><span>C</span><small>LOCAL</small></div>
      <div className="signal-line signal-ab" aria-hidden="true"><i /></div>
      <div className="signal-line signal-bc" aria-hidden="true"><i /></div>
      <div className="field-caption"><span>GLOBAL REACH</span><strong>WITHOUT GLOBAL STATE</strong></div>
    </div>
  );
}

function Hero() {
  return (
    <section className="landing-hero">
      <div className="hero-copy">
        <p className="kicker">Cross-local network / RCPAN</p>
        <h1>Money moves<br />point to point.</h1>
        <p className="hero-lede">One protocol for every jurisdiction and programmable ledger. Credit where it scales. Collateral where it secures.</p>
        <div className="hero-actions">
          <LaunchLink className="button-primary">Launch xln <Arrow /></LaunchLink>
          <a className="button-secondary" href="/install">Own the runtime <Arrow /></a>
        </div>
      </div>
      <NetworkField />
      <div className="hero-index" aria-hidden="true"><span>XLN / 01</span><span>SCROLL TO TRACE THE NETWORK</span></div>
    </section>
  );
}

function ProtocolProof() {
  return (
    <section className="protocol-proof" aria-labelledby="protocol-title">
      <header className="section-heading">
        <p className="kicker">The constraint</p>
        <h2 id="protocol-title">Broadcast is the bottleneck.<br /><em>Unicast is the way through.</em></h2>
      </header>
      <div className="proof-comparison">
        <div className="broadcast-model">
          <span className="model-label">Global broadcast</span>
          <div className="broadcast-grid" aria-hidden="true">{Array.from({ length: 25 }, (_, index) => <i key={index} />)}</div>
          <p>Every participant absorbs everybody else’s traffic.</p>
          <strong>O(n) replication</strong>
        </div>
        <div className="unicast-model">
          <span className="model-label">xln unicast</span>
          <div className="unicast-track" aria-hidden="true"><i /><b /><i /><b /><i /></div>
          <p>Only counterparties on the selected route update state.</p>
          <strong>O(1) per hop</strong>
        </div>
      </div>
    </section>
  );
}

function SettlementEvolution() {
  return (
    <section className="settlement-section" aria-labelledby="settlement-title">
      <div className="settlement-copy">
        <p className="kicker">The synthesis</p>
        <h2 id="settlement-title">The missing settlement primitive.</h2>
        <p>Traditional banking proved that credit scales. Payment channels proved that bilateral state can be enforced. xln combines both.</p>
      </div>
      <div className="settlement-equation">
        <div><span>~5000 BC</span><strong>FCUAN</strong><small>Credit without proof</small></div>
        <b aria-hidden="true">+</b>
        <div><span>2015</span><strong>FRPAP</strong><small>Proof without credit</small></div>
        <b aria-hidden="true">=</b>
        <div className="equation-result"><span>2026 →</span><strong>RCPAN</strong><small>Credit with proof</small></div>
      </div>
      <div className="invariant-strip">
        <span>Bilateral invariant</span>
        <strong>−C<sub>L</sub> ≤ Δ ≤ R + C<sub>R</sub></strong>
        <small>bounded credit · reserves · mechanical enforcement</small>
      </div>
    </section>
  );
}

function OperatingProperties() {
  return (
    <section className="properties-section" aria-labelledby="properties-title">
      <header>
        <p className="kicker">Operating properties</p>
        <h2 id="properties-title">Global finance,<br />kept local.</h2>
      </header>
      <ol>
        {PROPERTIES.map(([number, title, detail]) => (
          <li key={number}><span>{number}</span><h3>{title}</h3><p>{detail}</p></li>
        ))}
      </ol>
    </section>
  );
}

function FinalCallout() {
  return (
    <section className="landing-callout">
      <p className="kicker">Your keys. Your node. Your rules.</p>
      <h2>Don’t rent the rail.<br /><em>Run it.</em></h2>
      <a className="callout-link" href="/install">Install xln <Arrow /></a>
      <blockquote>“After 13 years auditing payment systems and blockchains, I built the protocol I kept wishing existed.”<cite>— Egor Homakov, Sakurity</cite></blockquote>
    </section>
  );
}

export function LandingPage() {
  return (
    <SiteShell activeRoute="/">
      <main>
        <Hero />
        <ProtocolProof />
        <SettlementEvolution />
        <OperatingProperties />
        <FinalCallout />
      </main>
      <SiteFooter />
    </SiteShell>
  );
}
