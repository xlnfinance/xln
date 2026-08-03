import { content } from '$lib/components/Landing/content';

import './landing.css';

const c = content.en;
const ROADMAP = [
  c.roadmap.q4_2025,
  c.roadmap.q1_2026,
  c.roadmap.q2_2026,
  c.roadmap.q3_2026,
  c.roadmap.q4_2026,
  c.roadmap.future,
] as const;

const CONTRACTS = [
  ['IEntityProvider', 'Identity, registration, and validator quorum', 'EntityProvider.sol'],
  ['IDepository', 'Collateral, FIFO debt, and settlement', 'Depository.sol'],
  ['IDeltaTransformers', 'HTLCs, swaps, and programmable account logic', 'SubcontractProvider.sol'],
] as const;

const PRINCIPLES = [c.tripleS.scalable, c.tripleS.secure, c.tripleS.simple] as const;

export default function LandingPage() {
  return (
    <div className="react-landing">
      <section className="landing-hero" aria-labelledby="landing-title">
        <div className="hero-copy">
          <p className="landing-kicker">xln / bilateral settlement protocol</p>
          <h1 id="landing-title">{c.hero.title}</h1>
          <p className="landing-subtitle">{c.hero.subtitle}</p>
          <div className="hero-actions">
            <a className="primary-action" href="/install">Run xln locally <span>↗</span></a>
            <a href="/docs">Read the protocol <span>→</span></a>
          </div>
        </div>
        <div className="hero-signal" aria-label="Reserve-credit settlement invariant">
          <div className="signal-topline"><span>ACCOUNT / 01</span><i>LIVE PROOF</i></div>
          <div className="signal-bike"><img src="/bikes/rcpan.svg" alt="RCPAN bicycle combining credit and reserves" /></div>
          <div className="signal-formula"><span>−C<sub>L</sub></span><strong>≤ Δ ≤</strong><span>R + C<sub>R</sub></span></div>
          <p>Credit where it scales. Collateral where it secures.</p>
        </div>
      </section>

      <section className="landing-proof" aria-label="Protocol proof points">
        <div><strong>O(1)</strong><span>per-hop updates</span></div>
        <div><strong>2</strong><span>signatures per account</span></div>
        <div><strong>0</strong><span>global sequencers</span></div>
        <div><strong>∞</strong><span>local ledgers</span></div>
      </section>

      <section className="landing-section evolution-section" aria-labelledby="evolution-title">
        <header>
          <p className="landing-kicker">Settlement, evolved</p>
          <h2 id="evolution-title">{c.solution.evolution}</h2>
          <p>{c.solution.intro.replaceAll(/<[^>]+>/g, '')}</p>
        </header>
        <div className="evolution-track">
          <article className="era credit-era">
            <span>~5000 BC</span><img src="/bikes/fcuan.svg" alt="" />
            <h3>FCUAN</h3><p>{c.solution.fcuanDesc}</p><code>[---.---]</code>
          </article>
          <div className="merge-mark" aria-hidden="true"><span>credit</span><b>＋</b><span>proof</span></div>
          <article className="era reserve-era">
            <span>2015</span><img src="/bikes/frpap.svg" alt="" />
            <h3>FRPAP</h3><p>{c.solution.frpapDesc}</p><code>[.===]</code>
          </article>
          <div className="merge-arrow" aria-hidden="true">→</div>
          <article className="era rcpan-era">
            <span>2026 →</span><img src="/bikes/rcpan.svg" alt="" />
            <h3>RCPAN</h3><p>xln unites provable reserves with bounded credit.</p><code>[---.===---]</code>
          </article>
        </div>
      </section>

      <section className="landing-section contract-section" aria-labelledby="contracts-title">
        <header>
          <p className="landing-kicker">On-chain fallback</p>
          <h2 id="contracts-title">{c.contracts.title}</h2>
          <p>{c.contracts.subtitle}</p>
        </header>
        <div className="contract-rail">
          {CONTRACTS.map(([name, description, file], index) => (
            <a href={`https://github.com/xlnfinance/xln/blob/main/jurisdictions/contracts/${file}`} target="_blank" rel="noreferrer" key={name}>
              <span>0{index + 1}</span><strong>{name}</strong><p>{description}</p><code>{file}</code>
            </a>
          ))}
        </div>
      </section>

      <section className="landing-section principles-section" aria-labelledby="principles-title">
        <header><p className="landing-kicker">Protocol posture</p><h2 id="principles-title">{c.tripleS.title}</h2></header>
        <div className="principle-grid">
          {PRINCIPLES.map((principle, index) => (
            <article key={principle.title}><span>0{index + 1}</span><h3>{principle.title}</h3><p>{principle.desc.replaceAll(/<[^>]+>/g, '')}</p></article>
          ))}
        </div>
      </section>

      <section className="landing-section roadmap-react" aria-labelledby="roadmap-title">
        <header><p className="landing-kicker">Build in public</p><h2 id="roadmap-title">{c.roadmap.title}</h2></header>
        <ol>
          {ROADMAP.map((milestone, index) => (
            <li className={index === 1 ? 'current' : index === 0 ? 'done' : undefined} key={milestone.quarter}>
              <span>{milestone.quarter}</span><div><h3>{milestone.title}</h3><p>{milestone.items.join(' · ')}</p></div>
            </li>
          ))}
        </ol>
      </section>

      <section className="landing-cta">
        <p className="landing-kicker">The account is the network</p>
        <h2>Build programmable finance without broadcasting every payment to the planet.</h2>
        <div className="hero-actions"><a className="primary-action" href="/app">Open the app <span>↗</span></a><a href="/rcpan">Inspect RCPAN <span>→</span></a></div>
      </section>
    </div>
  );
}
