<script lang="ts">
  import './landing-page.css';
  import { onMount } from 'svelte';
  import { browser } from '$app/environment';
  import ComparativeChart from './ComparativeChart.svelte';
  import InvariantTicker from '../Home/InvariantTicker.svelte';
  import Collapsible from './Collapsible.svelte';
  import { content, type Content, type ContentLang } from './content';
  import { locale } from '$lib/i18n';

  export let onUnlock: () => void;

  $: c = content[$locale in content ? $locale as ContentLang : 'en'] as Content;

  let inviteCode = '';
  let error = '';
  let expandedCard: number | null = null;
  let copiedCard: number | null = null;

  let comparativeCollapsed = true;
  let promptsCollapsed = true;

  let showSubmitForm = false;
  let submissionText = '';
  let shareUrl = '';
  let submissionStatus = '';
  let superpromptText = '';
  let superpromptError = '';
  let showInvite = true;
  let darkMode = true;

  const PROMPTS = [
    {
      persona: "elite VC committee",
      task: "Identify moat, scalability edge, and monetization route. Critique the weakest link — what must be proven in MVP before $10M is justified.",
      metrics: ["Novelty", "Technical Soundness", "Strategic Relevance", "Global Impact", "Execution Risk"]
    },
    {
      persona: "AGI optimizing for human prosperity and systemic stability",
      task: "Analyze as a proposal for the next financial substrate of civilization.",
      metrics: ["Innovation", "Societal Benefit", "Risk to Stability", "Long-Term Viability", "Human Alignment"]
    },
    {
      persona: "board of central bankers from G20 nations",
      task: "Evaluate systemic risk, monetary policy implications, and cross-border settlement feasibility. What regulatory framework would be needed?",
      metrics: ["Policy Compatibility", "Systemic Risk", "Cross-Border Utility", "Adoption Feasibility", "Regulatory Complexity"]
    },
    {
      persona: "council of Nobel Prize-winning economists",
      task: "Assess mechanism design, game theory soundness, and macroeconomic impact. Compare to existing payment systems and central bank digital currencies.",
      metrics: ["Economic Soundness", "Mechanism Design", "Market Efficiency", "Systemic Impact", "Implementation Risk"]
    },
    {
      persona: "team of cryptographers and security researchers",
      task: "Audit Byzantine fault tolerance, cryptographic primitives, and attack vectors. Identify potential exploits and mitigation strategies.",
      metrics: ["Cryptographic Security", "BFT Correctness", "Attack Resistance", "Privacy Guarantees", "Implementation Risk"]
    },
    {
      persona: "panel of fintech CTOs from Stripe, Square, and Revolut",
      task: "Evaluate technical architecture, scalability constraints, and integration complexity. What would adoption cost for a 10M user platform?",
      metrics: ["Technical Feasibility", "Scalability", "Integration Complexity", "Operational Cost", "Time to Market"]
    },
    {
      persona: "IMF research division",
      task: "Analyze impact on financial inclusion, remittance markets, and developing economies. Could this reduce correspondent banking costs?",
      metrics: ["Financial Inclusion", "Remittance Efficiency", "Developing Market Fit", "Correspondent Banking Impact", "Implementation Barrier"]
    },
    {
      persona: "Lightning Network core developers",
      task: "Compare to Lightning's design tradeoffs. Where does credit extension create new attack surfaces vs unlock new use cases?",
      metrics: ["Design Innovation", "Security vs Lightning", "Use Case Expansion", "Complexity Tradeoff", "Adoption Risk"]
    },
    {
      persona: "Ethereum Foundation researchers",
      task: "Evaluate as a Layer 2 settlement primitive. Could this be the missing piece for cross-rollup liquidity?",
      metrics: ["L2 Compatibility", "Cross-Rollup Utility", "EVM Integration", "Decentralization", "Censorship Resistance"]
    },
    {
      persona: "compliance officers from major banks",
      task: "Assess AML/KYC compatibility, regulatory reporting, and jurisdictional risk. What would audit and compliance infrastructure require?",
      metrics: ["AML/KYC Feasibility", "Regulatory Clarity", "Audit Trail Quality", "Jurisdictional Risk", "Compliance Cost"]
    }
  ];

  function formatPrompt(prompt: typeof PROMPTS[0]): string {
    const metricsFormatted = prompt.metrics.map(m => `${m} — ☐/1000`).join('\n');
    return `Review the XLN architecture, contracts, and runtime source, then:\n\nYou are ${prompt.persona}.\n${prompt.task}\n\nOutput TL;DR:\n${metricsFormatted}\n→ Final Verdict: (one-line insight)`;
  }

  function handleSubmit() {
    if (inviteCode.toLowerCase() === 'mml') {
      if (browser) {
        localStorage.setItem('open', 'true');
      }
      onUnlock();
    } else {
      error = 'Invalid code';
      setTimeout(() => error = '', 2000);
    }
  }

  async function copyPrompt(index: number, event?: Event) {
    const promptData = PROMPTS[index];
    if (!promptData) return;
    const prompt = formatPrompt(promptData);
    if (browser) {
      await navigator.clipboard.writeText(prompt);
      copiedCard = index;

      const btn = event?.target as HTMLElement;
      if (btn) {
        btn.style.animation = 'pulse 0.3s ease';
        setTimeout(() => btn.style.animation = '', 300);
      }

      setTimeout(() => copiedCard = null, 2000);
    }
  }

  async function copyAllPrompts(event?: Event) {
    const allPrompts = PROMPTS.map((p, i) => `# Prompt ${i + 1}: ${p.persona}\n\n${formatPrompt(p)}`).join('\n\n---\n\n');
    if (browser) {
      await navigator.clipboard.writeText(allPrompts);
      copiedCard = -1;

      const btn = event?.target as HTMLElement;
      if (btn) {
        btn.style.animation = 'pulse 0.3s ease';
        setTimeout(() => btn.style.animation = '', 300);
      }

      setTimeout(() => copiedCard = null, 2000);
    }
  }

  function toggleCard(index: number) {
    expandedCard = expandedCard === index ? null : index;
  }

  function errorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
  }

  async function loadSuperprompt(): Promise<string> {
    const response = await fetch('/superprompt.txt');
    if (!response.ok) {
      throw new Error(`SUPERPROMPT_LOAD_FAILED:${response.status}`);
    }
    return await response.text();
  }

  async function copySuperprompt(event?: Event) {
    if (browser) {
      try {
        const text = await loadSuperprompt();
        superpromptText = text;
        superpromptError = '';
        await navigator.clipboard.writeText(text);
        copiedCard = -2;

        const btn = event?.target as HTMLElement;
        if (btn) {
          btn.style.animation = 'pulse 0.3s ease';
          setTimeout(() => btn.style.animation = '', 300);
        }

        setTimeout(() => copiedCard = null, 2000);
      } catch (error) {
        superpromptError = errorMessage(error);
      }
    }
  }

  onMount(async () => {
    if (browser) {
      try {
        superpromptText = await loadSuperprompt();
        superpromptError = '';
      } catch (error) {
        superpromptError = errorMessage(error);
      }

      if (window.location.hash === '#MML') {
        localStorage.setItem('open', 'true');
        window.location.hash = '';
        onUnlock();
      }
    }
  });

  async function submitEvaluation() {
    if (!submissionText || submissionText.length < 100) {
      submissionStatus = '❌ Please paste the full response';
      setTimeout(() => submissionStatus = '', 3000);
      return;
    }

    try {
      const response = await fetch('http://localhost:3001/api/submit', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          shareUrl,
          rawText: submissionText
        })
      });

      const result = await response.json();

      if (result.success) {
        submissionStatus = `✅ Submitted! ID: ${result.submissionId}`;
        submissionText = '';
        shareUrl = '';
        setTimeout(() => {
          submissionStatus = '';
          showSubmitForm = false;
        }, 3000);
      } else {
        submissionStatus = `❌ ${result.error}`;
        setTimeout(() => submissionStatus = '', 4000);
      }
    } catch (error) {
      submissionStatus = '❌ API server not running (start with: bun api-server.ts)';
      setTimeout(() => submissionStatus = '', 4000);
    }
  }
</script>

<!-- Theme controls moved to Topbar -->

<div class="landing" class:light-mode={!darkMode}>
  <div class="content">
    <!-- Main Tagline -->
    <div class="hero-tagline">
      <h1>{c.hero.title}</h1>
      <p class="hero-subtitle">{c.hero.subtitle}</p>
    </div>

    <!-- Founder Context -->
    <div class="founder-note founder-note-quote">
      <p class="quote-text">
        <span class="quote-mark">"</span>{c.founder.quote}<span class="quote-mark">"</span>
      </p>
      <p class="signature">
        — {c.founder.signature} (<a href="https://sakurity.com" target="_blank" rel="noopener" class="founder-link">Sakurity</a>)
      </p>
    </div>

    <div class="problem-solution">
      <div class="section">
        <h2>{c.problem.title}</h2>
        <p class="intro">{@html c.problem.intro}</p>
        <p class="vision-text">{c.problem.vision}</p>
        <ul>
          <li>{@html c.problem.tradfi}</li>
          <li>{@html c.problem.bigBlocks}</li>
          <li>{@html c.problem.rollups}</li>
          <li>{@html c.problem.sharding}</li>
        </ul>

        <div class="technical-context">
          <p class="vision-text">{@html c.problem.fcuan}</p>

          <p class="vision-text">{@html c.problem.frpap}</p>
        </div>
      </div>

      <div class="section">
        <h2>{c.solution.title}</h2>
        <p class="intro">{@html c.solution.intro}</p>

        <!-- Evolution Timeline - Simple Linear History -->
        <div class="evolution-simple">
          <h3 class="evo-title">{c.solution.evolution}</h3>

          <div class="evo-convergence">
            <!-- Left: Two source systems stacked -->
            <div class="evo-sources">
              <!-- Banking (FCUAN) -->
              <div class="evo-item evo-item-fcuan" title="Full-Credit Unprovable Account Networks: Banking since ancient times">
                <div class="evo-label-top">~5000 BC</div>
                <div class="bike-container bike-container-shake">
                  <img src="/bikes/fcuan.svg" class="evo-bike evo-bike-wobble" alt="" />
                  <span class="crisis-badge">CRISIS</span>
                  <span class="dust-particle dust-1"></span>
                  <span class="dust-particle dust-2"></span>
                  <span class="dust-particle dust-3"></span>
                  <span class="dust-particle dust-4"></span>
                  <span class="dust-particle dust-5"></span>
                </div>
                <div class="evo-name">FCUAN</div>
                <div class="evo-fullname">Full-Credit Unprovable Account Networks</div>
                <InvariantTicker label="" description="−leftCredit ≤ Δ ≤ rightCredit" pattern="[---.---]" speed={4} />
                <div class="evo-desc">{c.solution.fcuanDesc}</div>
              </div>

              <!-- Lightning (FRPAP) -->
              <div class="evo-item evo-item-branch" title="Fully-Reserved Provable Account Protocols: Lightning/PCNs - technically sound but lacks credit">
                <div class="evo-label-top">2015-2025</div>
                <div class="bike-container">
                  <img src="/bikes/frpap.svg" class="evo-bike evo-bike-small evo-bike-locked" alt="" />
                  <div class="wall-stack">
                    <div class="wall-brick">Inbound</div>
                    <div class="wall-brick">Liquidity</div>
                    <div class="wall-brick">Wall</div>
                  </div>
                </div>
                <div class="evo-name">FRPAP</div>
                <div class="evo-fullname">Full-Reserve Provable Account Primitives</div>
                <InvariantTicker label="" description="0 ≤ Δ ≤ collateral" pattern="[.===]" speed={4} />
                <div class="evo-desc">{c.solution.frpapDesc}</div>
              </div>
            </div>

            <!-- Middle: Convergence lines + arrows -->
            <div class="evo-merge-zone">
              <svg class="convergence-lines" viewBox="0 0 140 380" preserveAspectRatio="xMidYMid meet">
                <defs>
                  <path id="credit-path" d="M 0 95 C 50 95, 100 150, 130 190" />
                  <path id="reserve-path" d="M 0 285 C 50 285, 100 230, 130 190" />
                </defs>
                <!-- Top curve from FCUAN (red) - CREDIT = risk -->
                <use href="#credit-path" stroke="rgba(220,80,80,0.6)" stroke-width="2.5" fill="none" class="flow-line" />
                <text class="curve-label curve-label-credit">
                  <textPath href="#credit-path" startOffset="15%">Credit</textPath>
                </text>
                <!-- Bottom curve from FRPAP (green) - RESERVE = safety -->
                <use href="#reserve-path" stroke="rgba(80,200,100,0.6)" stroke-width="2.5" fill="none" class="flow-line" />
                <text class="curve-label curve-label-reserve">
                  <textPath href="#reserve-path" startOffset="15%">Reserve</textPath>
                </text>
                <!-- Merge point -->
                <circle cx="130" cy="190" r="5" fill="#6b9fff" opacity="0.95">
                  <animate attributeName="r" values="4;6;4" dur="1.2s" repeatCount="indefinite"/>
                </circle>
              </svg>
              <!-- = sign + Animated arrows → RCPAN -->
              <div class="evo-merge-flow">
                <span class="merge-equals">=</span>
                <span class="merge-arrow">→</span>
                <span class="merge-arrow">→</span>
              </div>
            </div>

            <!-- Right: Result (RCPAN) -->
            <div class="evo-result">
              <div class="evo-item evo-item-finale" title="Reserve-Credit Provable Account Network: The best of both worlds - provable AND credit-enabled">
                <div class="evo-label-top">2026 →</div>
                <div class="rcpan-container">
                  <img src="/bikes/rcpan.svg" class="evo-bike evo-bike-finale evo-bike-flying" alt="" />
                  <span class="trail-particle trail-1"></span>
                  <span class="trail-particle trail-2"></span>
                  <span class="trail-particle trail-3"></span>
                  <span class="trail-particle trail-4"></span>
                  <span class="trail-particle trail-5"></span>
                  <span class="trail-particle trail-6"></span>
                </div>
                <div class="evo-name evo-name-finale">RCPAN</div>
                <div class="evo-fullname">Reserve-Credit Provable Account Network</div>
                <InvariantTicker label="" description="−leftCredit ≤ Δ ≤ collateral + rightCredit" pattern="[---.===---]" speed={4} />
                <div class="evo-desc evo-desc-finale">{@html c.solution.rcpanDesc}</div>
              </div>
            </div>
          </div>

          <!-- Color Legend -->
          <div class="color-legend">
            <div class="legend-item">
              <span class="legend-box legend-credit">−</span>
              <span class="legend-text">Credit (Red)</span>
            </div>
            <div class="legend-item">
              <span class="legend-box legend-reserve">=</span>
              <span class="legend-text">Reserve (Green)</span>
            </div>
            <div class="legend-item">
              <span class="legend-box legend-both">−.=</span>
              <span class="legend-text">RCPAN = Both United</span>
            </div>
          </div>
        </div>

        <div class="formula-variants">
          <div class="formula-box">
            <div class="formula-label">Bilateral Invariant</div>
            <div class="formula-math">−Cₗ ≤ Δ ≤ R + Cᵣ</div>
            <div class="formula-desc">Left credit · Delta · Reserves + Right credit</div>
          </div>

          <div class="formula-divider">≡</div>

          <div class="formula-box">
            <div class="formula-label">Set Theory</div>
            <div class="formula-math">Δ ∈ [−Cₗ, R + Cᵣ]</div>
            <div class="formula-desc">Delta in closed interval</div>
          </div>
        </div>
      </div>

      <!-- Why Now? - Urgency Section -->
      <div class="section urgency-section">
        <h2 style="color: #00d1ff;">{c.whyNow.title}</h2>
        <ul class="properties-list">
          {#each c.whyNow.items as item}
            <li>{@html item}</li>
          {/each}
        </ul>
      </div>

      <!-- Smart Contracts Architecture -->
      <div class="section contracts-section">
        <h2>{c.contracts.title}</h2>
        <p class="architecture-subtitle">{c.contracts.subtitle}</p>

        <!-- SLOT MACHINE: 777 Style Modularity -->
        <div class="contracts-slot-machine">
          <!-- Left: Entity Provider -->
          <a href="https://github.com/xlnfinance/xln/blob/main/jurisdictions/contracts/EntityProvider.sol" target="_blank" rel="noopener" class="slot-reel slot-left">
            <div class="slot-label">PLUGGABLE</div>
            <div class="contract-icon-slot">🏛️</div>
            <div class="interface-name-slot">IEntityProvider</div>
            <div class="contract-name-slot">EntityProvider.sol</div>
            <div class="slot-desc">Entity registration<br/>BFT quorum</div>
            <div class="slot-tag">↔ SWAP</div>
          </a>

          <!-- Center: Depository (GOLDEN JACKPOT) -->
          <a href="https://github.com/xlnfinance/xln/blob/main/jurisdictions/contracts/Depository.sol" target="_blank" rel="noopener" class="slot-reel slot-center">
            <div class="slot-label-gold">⭐ CORE ⭐</div>
            <div class="contract-icon-slot-gold">📜</div>
            <div class="interface-name-slot-gold">IDepository</div>
            <div class="contract-name-slot-gold">Depository.sol</div>
            <div class="slot-features-gold">
              <div>• Collateral</div>
              <div>• FIFO</div>
              <div>• Settlement</div>
            </div>
            <div class="slot-tag-gold">ANCHOR</div>
          </a>

          <!-- Right: Delta Transformers -->
          <a href="https://github.com/xlnfinance/xln/blob/main/jurisdictions/contracts/SubcontractProvider.sol" target="_blank" rel="noopener" class="slot-reel slot-right">
            <div class="slot-label">PLUGGABLE</div>
            <div class="contract-icon-slot">⚡</div>
            <div class="interface-name-slot">IDeltaTransformers</div>
            <div class="contract-name-slot">SubcontractProvider.sol</div>
            <div class="slot-desc">HTLCs, swaps<br/>Limit orders</div>
            <div class="slot-tag">EXTEND ↔</div>
          </a>

          <!-- Many-to-Many Connections -->
          <svg class="slot-connections" viewBox="0 0 600 300">
            <defs>
              <marker id="slot-arrow" markerWidth="7" markerHeight="7" refX="6" refY="3.5" orient="auto">
                <polygon points="0 0, 7 3.5, 0 7" fill="rgba(79,209,139,0.2)" />
              </marker>
              <marker id="slot-arrow-gold" markerWidth="8" markerHeight="8" refX="7" refY="4" orient="auto">
                <polygon points="0 0, 8 4, 0 8" fill="rgba(255,215,0,0.3)" />
              </marker>
            </defs>
            <!-- Left ↔ Center (GOLD) -->
            <path d="M 180 110 L 280 110" stroke="rgba(255,215,0,0.18)" stroke-width="1.5" stroke-dasharray="4 4" marker-end="url(#slot-arrow-gold)">
              <animate attributeName="stroke-dashoffset" from="0" to="8" dur="1.5s" repeatCount="indefinite" />
            </path>
            <path d="M 280 150 L 180 150" stroke="rgba(255,215,0,0.18)" stroke-width="1.5" stroke-dasharray="4 4" marker-end="url(#slot-arrow-gold)">
              <animate attributeName="stroke-dashoffset" from="0" to="8" dur="1.5s" repeatCount="indefinite" />
            </path>
            <!-- Center ↔ Right (GOLD) -->
            <path d="M 320 110 L 420 110" stroke="rgba(255,215,0,0.18)" stroke-width="1.5" stroke-dasharray="4 4" marker-end="url(#slot-arrow-gold)">
              <animate attributeName="stroke-dashoffset" from="0" to="8" dur="1.5s" repeatCount="indefinite" />
            </path>
            <path d="M 420 150 L 320 150" stroke="rgba(255,215,0,0.18)" stroke-width="1.5" stroke-dasharray="4 4" marker-end="url(#slot-arrow-gold)">
              <animate attributeName="stroke-dashoffset" from="0" to="8" dur="1.5s" repeatCount="indefinite" />
            </path>
            <!-- Left ↔ Right (indirect, subtle) -->
            <path d="M 180 130 L 420 130" stroke="rgba(79,209,139,0.1)" stroke-width="1" stroke-dasharray="3 3" opacity="0.6">
              <animate attributeName="opacity" values="0.3;0.6;0.3" dur="3s" repeatCount="indefinite" />
            </path>
          </svg>
        </div>
        <div class="architecture-note">
          <strong>Depository</strong> = immutable trust anchor.
          <strong>Modules</strong> = hot-swappable implementations.
          Deploy <code>YourCustomEntityProvider.sol</code> anytime.
        </div>
      </div>

      <div class="section">
        <h2>{c.properties.title}</h2>
        <ul class="properties-list">
          {#each c.properties.items as item}
            <li>{@html item}</li>
          {/each}
        </ul>
      </div>

      <!-- Triple-S First Principles -->
      <div class="section triple-s">
        <h2>{c.tripleS.title}</h2>
        <div class="principles-grid">
          <div class="principle-card">
            <div class="principle-icon">⚡</div>
            <h3>{c.tripleS.scalable.title}</h3>
            <p>{@html c.tripleS.scalable.desc}</p>
            <p class="principle-detail">{c.tripleS.scalable.detail1}</p>
            <p class="principle-detail">{c.tripleS.scalable.detail2}</p>
          </div>
          <div class="principle-card">
            <div class="principle-icon">🔒</div>
            <h3>{c.tripleS.secure.title}</h3>
            <p>{@html c.tripleS.secure.desc}</p>
            <p class="principle-detail">{c.tripleS.secure.detail1}</p>
            <p class="principle-detail">{c.tripleS.secure.detail2}</p>
          </div>
          <div class="principle-card">
            <div class="principle-icon">✨</div>
            <h3>{c.tripleS.simple.title}</h3>
            <p>{@html c.tripleS.simple.desc}</p>
            <p class="principle-detail">{c.tripleS.simple.detail1}</p>
            <p class="principle-detail">{c.tripleS.simple.detail2}</p>
          </div>
        </div>
      </div>

      <!-- Roadmap -->
      <div class="section roadmap-section">
        <h2 style="color: #00d1ff;">{c.roadmap.title}</h2>

        <div class="roadmap-timeline">
          <div class="roadmap-item completed">
            <div class="roadmap-marker">✓</div>
            <div class="roadmap-content">
              <div class="roadmap-quarter">{c.roadmap.q4_2025.quarter}</div>
              <div class="roadmap-title">{c.roadmap.q4_2025.title}</div>
              <div class="roadmap-details">
                {#each c.roadmap.q4_2025.items as item}
                  <span class="detail-item">{item}</span>
                {/each}
              </div>
            </div>
          </div>

          <div class="roadmap-item active">
            <div class="roadmap-marker">⟳</div>
            <div class="roadmap-content">
              <div class="roadmap-quarter">{c.roadmap.q1_2026.quarter}</div>
              <div class="roadmap-title">{c.roadmap.q1_2026.title}</div>
              <div class="roadmap-details">
                {#each c.roadmap.q1_2026.items as item}
                  <span class="detail-item">{item}</span>
                {/each}
              </div>
            </div>
          </div>

          <div class="roadmap-item">
            <div class="roadmap-marker">○</div>
            <div class="roadmap-content">
              <div class="roadmap-quarter">{c.roadmap.q2_2026.quarter}</div>
              <div class="roadmap-title">{c.roadmap.q2_2026.title}</div>
              <div class="roadmap-details">
                {#each c.roadmap.q2_2026.items as item}
                  <span class="detail-item">{item}</span>
                {/each}
              </div>
            </div>
          </div>

          <div class="roadmap-item">
            <div class="roadmap-marker">○</div>
            <div class="roadmap-content">
              <div class="roadmap-quarter">{c.roadmap.q3_2026.quarter}</div>
              <div class="roadmap-title">{c.roadmap.q3_2026.title}</div>
              <div class="roadmap-details">
                {#each c.roadmap.q3_2026.items as item}
                  <span class="detail-item">{item}</span>
                {/each}
              </div>
            </div>
          </div>

          <div class="roadmap-item">
            <div class="roadmap-marker">○</div>
            <div class="roadmap-content">
              <div class="roadmap-quarter">{c.roadmap.q4_2026.quarter}</div>
              <div class="roadmap-title">{c.roadmap.q4_2026.title}</div>
              <div class="roadmap-details">
                {#each c.roadmap.q4_2026.items as item}
                  <span class="detail-item">{item}</span>
                {/each}
              </div>
            </div>
          </div>

          <div class="roadmap-item">
            <div class="roadmap-marker">◇</div>
            <div class="roadmap-content">
              <div class="roadmap-quarter">{c.roadmap.future.quarter}</div>
              <div class="roadmap-title">{c.roadmap.future.title}</div>
              <div class="roadmap-details">
                {#each c.roadmap.future.items as item}
                  <span class="detail-item">{item}</span>
                {/each}
              </div>
            </div>
          </div>
        </div>
      </div>

      <!-- Newsletter Signup -->
      <div class="newsletter-section">
        <div class="newsletter-header">
          <h3>{c.newsletter.title}</h3>
          <p>{c.newsletter.subtitle}</p>
        </div>
        <form
          action="https://buttondown.email/api/emails/embed-subscribe/xln"
          method="post"
          target="popupwindow"
          class="newsletter-form"
        >
          <input
            type="email"
            name="email"
            placeholder={c.newsletter.placeholder}
            required
            class="newsletter-input"
          />
          <button type="submit" class="newsletter-btn">
            {c.newsletter.button}
          </button>
        </form>
        <p class="newsletter-note">{c.newsletter.note}</p>
      </div>

      <!-- Plot Twist -->
      <div class="section plot-twist">
        <h2>{c.cbdc.title}</h2>
        <p class="intro">{c.cbdc.intro}</p>

        <div class="roadmap-box">
          <p class="roadmap-text">{@html c.cbdc.today}</p>
          <p class="roadmap-text">{@html c.cbdc.tomorrow}</p>
        </div>

        <div class="cbdc-stat">
          <div class="stat-stack">
            <div class="stat-number-large">137</div>
            <div class="stat-sublabel">{c.cbdc.countries}</div>
          </div>
          <div class="stat-stack">
            <div class="stat-number-medium">72</div>
            <div class="stat-sublabel">{c.cbdc.pilot}</div>
          </div>
          <div class="stat-stack">
            <div class="stat-number-large">98%</div>
            <div class="stat-sublabel">{c.cbdc.gdp}</div>
          </div>
          <div class="stat-description">
            {c.cbdc.building} (<a href="https://www.atlanticcouncil.org/cbdctracker/" target="_blank" rel="noopener noreferrer" class="stat-link">CBDCs</a>)
          </div>
        </div>

        <p class="vision-text">{@html c.cbdc.vision}</p>
      </div>
    </div>

    <div class="prompt-container">
      <!-- AI SUPERPROMPT -->
      <Collapsible title="AI Superprompt" bind:collapsed={comparativeCollapsed}>
        <div class="superprompt-section">
          <div class="superprompt-actions">
            <button on:click={(event) => copySuperprompt(event)} class="copy-super-btn">
              {copiedCard === -2 ? '✓ Copied' : 'Copy Superprompt'}
            </button>
            <button on:click={() => showSubmitForm = !showSubmitForm} class="submit-toggle-btn">
              {showSubmitForm ? 'Hide Form' : 'Submit Results'}
            </button>
          </div>

          <p class="section-desc">Compare xln against the entire $100T finance stack — from TradFi/CEX to rollups</p>

          {#if superpromptError}
            <div class="submission-status superprompt-error" data-testid="superprompt-load-error">
              Superprompt failed to load: {superpromptError}
            </div>
          {/if}

          {#if superpromptText}
            <div class="superprompt-preview">
              <div class="preview-label">Superprompt Preview:</div>
              <textarea readonly rows="10" class="preview-text" value={superpromptText}></textarea>
            </div>
          {/if}

          {#if showSubmitForm}
            <div class="submit-form">
              <div class="form-row">
                <input
                  type="url"
                  bind:value={shareUrl}
                  placeholder="Shareable link (optional): https://chatgpt.com/share/xyz"
                  class="form-input"
                />
              </div>
              <div class="form-row">
                <textarea
                  bind:value={submissionText}
                  placeholder="Paste the full model response here (must include the table)"
                  rows="12"
                  class="form-textarea"
                ></textarea>
              </div>
              {#if submissionStatus}
                <div class="submission-status">{submissionStatus}</div>
              {/if}
              <button on:click={submitEvaluation} class="submit-btn">
                Submit Evaluation
              </button>
              <p class="submit-note">
                Submissions go to moderation queue. Admin will review and approve valid results.
              </p>
            </div>
          {/if}

          <!-- Results Visualization -->
          <ComparativeChart {darkMode} />
        </div>
      </Collapsible>

      <div class="divider"></div>

      <!-- 10 EXPERT PROMPTS -->
      <Collapsible title="10 Expert Perspectives" bind:collapsed={promptsCollapsed}>
        <div class="prompt-section">
          <div class="prompt-header">
            <div class="prompt-label">
              <div class="label-subtitle">
                Prompt template: review the XLN architecture, contracts, and runtime source.
                <br/>Then evaluate as [persona] using the scoring rubric below.
              </div>
            </div>
            <button on:click={(e) => copyAllPrompts(e)} class="copy-all-btn">
              {copiedCard === -1 ? '✓ Copied All' : 'Copy All 10'}
            </button>
          </div>

          <div class="prompt-grid">
            {#each PROMPTS as prompt, i}
              <div class="prompt-card" class:expanded={expandedCard === i}>
                <button type="button" class="card-header" on:click={() => toggleCard(i)}>
                  <span class="persona-name">{prompt.persona}</span>
                  <span class="expand-icon">{expandedCard === i ? '−' : '+'}</span>
                </button>
                {#if expandedCard === i}
                  <div class="card-content">
                    <pre class="prompt-text">{formatPrompt(prompt)}</pre>
                    <button on:click|stopPropagation={(e) => copyPrompt(i, e)} class="copy-btn">
                      {copiedCard === i ? '✓ Copied' : 'Copy Prompt'}
                    </button>
                  </div>
                {/if}
              </div>
            {/each}
          </div>
        </div>
      </Collapsible>
    </div>

    {#if showInvite}
      <div class="invite-form">
        <div class="invite-label">🔐 Early Access (Invite Only)</div>
        <input
          type="text"
          bind:value={inviteCode}
          placeholder={c.invite.placeholder}
          on:keydown={(e) => e.key === 'Enter' && handleSubmit()}
          class="invite-input"
        />
        <button on:click={handleSubmit} class="enter-btn">
          {c.invite.button}
        </button>
        {#if error}
          <div class="error">{c.invite.invalid}</div>
        {/if}
        <p class="invite-note">DM @xlnfinance for access</p>
      </div>
    {/if}

    <div class="footer">
      <div class="footer-links">
        <a href="https://x.com/xlnfinance" target="_blank" rel="noopener noreferrer" class="footer-link">x.com/xlnfinance</a>
        <span class="separator">·</span>
        <a href="https://t.me/xlnomist" target="_blank" rel="noopener noreferrer" class="footer-link">t.me/xlnomist</a>
        <span class="separator">·</span>
        <a href="https://github.com/xlnfinance/xln" target="_blank" rel="noopener noreferrer" class="footer-link">github.com/xlnfinance/xln</a>
        <span class="separator">·</span>
        <a href="mailto:h@xln.finance" class="footer-link">h@xln.finance</a>
      </div>
      <div class="tagline">Cross-Local Network · Off-chain settlement with on-chain anchoring</div>
    </div>
  </div>
</div>
