<script lang="ts">
  import { onMount } from 'svelte';
  import { browser } from '$app/environment';
  import ComparativeChart from './ComparativeChart.svelte';
  import InvariantTicker from '../Home/InvariantTicker.svelte';
  import Collapsible from './Collapsible.svelte';
  import NetworkAnimation from './NetworkAnimation.svelte';

  export let onUnlock: () => void;

  let inviteCode = '';
  let error = '';
  let expandedCard: number | null = null;
  let copiedCard: number | null = null;

  // Collapsible section state (collapsed by default for lighter UX)
  let broadcastCollapsed = true;
  let comparativeCollapsed = true;
  let promptsCollapsed = true;

  let showSubmitForm = false;
  let submissionText = '';
  let shareUrl = '';
  let submissionStatus = '';
  let superpromptText = '';
  let showInvite = true;
  let darkMode = true; // Default to dark mode (black background)

  const SUPERPROMPT = {
    persona: "ULTIMATE COMPARATIVE ANALYSIS",
    task: "Compare xln against all major payment solutions (CEX, Lightning, Raiden, Plasma, Optimistic/ZK Rollups, Sharding, Big Blocks) across 6 dimensions. Output machine-parseable table with rankings.",
    metrics: ["Innovation", "Scalability", "Security", "Decentralization", "UX", "Capital Efficiency"]
  };

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
    return `Read xln.finance/c.txt fully, then:\n\nYou are ${prompt.persona}.\n${prompt.task}\n\nOutput TL;DR:\n${metricsFormatted}\n→ Final Verdict: (one-line insight)`;
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

      // Trigger animation
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
      copiedCard = -1; // Special value for "all"

      // Trigger animation
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

  async function copySuperprompt() {
    if (browser) {
      const response = await fetch('/superprompt.txt');
      const text = await response.text();
      superpromptText = text; // Store for preview
      await navigator.clipboard.writeText(text);
      copiedCard = -2; // Special value for superprompt

      // Trigger animation
      const btn = event?.target as HTMLElement;
      if (btn) {
        btn.style.animation = 'pulse 0.3s ease';
        setTimeout(() => btn.style.animation = '', 300);
      }

      setTimeout(() => copiedCard = null, 2000);
    }
  }

  // Load superprompt on mount for preview
  onMount(async () => {
    if (browser) {
      try {
        const response = await fetch('/superprompt.txt');
        superpromptText = await response.text();
      } catch (error) {
        console.error('Failed to load superprompt:', error);
      }

      // Check for #MML hash (fallback if +page.svelte didn't catch it)
      if (window.location.hash === '#MML') {
        localStorage.setItem('open', 'true');
        window.location.hash = ''; // Remove hash after processing
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

<NetworkAnimation {darkMode} onToggleDarkMode={() => darkMode = !darkMode} />

<div class="landing" class:light-mode={!darkMode}>
  <div class="content">
    <img src="/img/logo.png" alt="xln" class="logo" />

    <!-- Main Tagline -->
    <div class="hero-tagline">
      <h1>One protocol. Every jurisdiction. Every programmable ledger.</h1>
      <p class="hero-subtitle">The universal CBDC substrate for planetary-scale settlement</p>
    </div>

    <!-- Credibility -->
    <div class="credibility-badge">
      <div class="credibility-main">
        Built by <a href="https://sakurity.com" target="_blank" rel="noopener noreferrer" class="sakurity-link">Egor Homakov</a> (<a href="https://sakurity.com" target="_blank" rel="noopener noreferrer" class="sakurity-link">Sakurity</a>)
      </div>
      <div class="credibility-sub">Sakurity-grade architecture • Open source • MIT license</div>
    </div>

    <div class="problem-solution">
      <div class="section">
        <h2>137 Countries Are Building Programmable Money</h2>
        <p class="intro">CBDCs, stablecoins, tokenized assets—98% of global GDP is going programmable. The $100 trillion question isn't <em>if</em> programmable ledgers win. It's <strong>how they scale without custodians</strong>.</p>
        <p class="vision-text">Every existing answer fails at planetary scale:</p>
        <ul>
          <li><strong>TradFi/CEX (traditional banks, Binance, Coinbase):</strong> $100T economy, $10T daily volume, but custodial — bank bailouts, FTX collapse, Mt. Gox</li>
          <li><strong>All big blockers (Solana, Tron, BSC):</strong> $80B+ market cap, but can't run full nodes — centralized by design</li>
          <li><strong>All rollups (Arbitrum, Optimism, zkSync, StarkNet):</strong> $10B+ TVL, but data availability paradox — trust third-party committees, ephemeral calldata, or expensive blobspace. The DA/verifier dilemma is mathematically unsolvable: you cannot have cheap verification, permanent data, and no trust assumptions simultaneously. It's a catch-22, not a tradeoff.</li>
          <li><strong>Sharding chains (NEAR, TON, Zilliqa, MultiversX):</strong> Still broadcast O(n) within shards — doesn't solve the fundamental bottleneck. Security dilution means one shard compromised, entire network at risk. Fishermen are security theater that breaks under economic pressure.</li>
        </ul>

        <div class="technical-context">
          <p class="vision-text">For centuries, finance ran on <strong>Full-Credit Unprovable Account Networks (FCUAN)</strong>: traditional banking, CEXs, brokers. Pure credit scales phenomenally but offers weak security—assets can be seized, hubs can default.</p>

          <p class="vision-text">In 2015, Lightning introduced <strong>Full-Reserve Provable Account Primitives (FRPAP)</strong>: payment channels with cryptographic proofs. Full security but hits the <em>inbound liquidity wall</em>—an architectural limit, not a bug. Lightning, Raiden, Connext, Celer — all payment channel projects are now dead or pivoted due to full-reserve constraints.</p>
        </div>
      </div>

      <div class="section">
        <h2>The Solution</h2>
        <p class="intro"><strong>xln</strong> is the first <strong>Reserve-Credit Provable Account Network (RCPAN)</strong>: credit where it scales, collateral where it secures. A principled hybrid.</p>

        <div class="invariant-box">
          <div class="tickers-grid">
            <div class="tickers-column">
              <InvariantTicker
                label="FCUAN"
                description="−leftCredit ≤ Δ ≤ rightCredit"
                pattern="[---.---]"
              />
              <InvariantTicker
                label="FRPAP"
                description="0 ≤ Δ ≤ collateral"
                pattern="[.===]"
              />
              <InvariantTicker
                label="RCPAN"
                description="−leftCredit ≤ Δ ≤ collateral + rightCredit"
                pattern="[---.===---]"
              />
            </div>
            <div class="visual-column">
              <img src="/img/RCPAN.png" alt="RCPAN Visual Metaphor" class="rcpan-visual" />
              <div class="visual-caption">Credit (left) + Reserves (center) + Credit (right) = Bounded risk at infinite scale</div>
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
        <h2 style="color: #00d1ff;">Why Now?</h2>
        <ul class="properties-list">
          <li><strong>2025:</strong> 72 CBDCs in pilot phase (Russia, China, EU actively testing)</li>
          <li><strong>2026:</strong> Cross-border CBDC interop becomes political imperative</li>
          <li><strong>Legacy rails incompatible:</strong> SWIFT and correspondent banking can't handle programmable money</li>
          <li><strong>Window closing:</strong> Each CBDC building incompatible scaling solution creates permanent fragmentation</li>
          <li><strong>Universal substrate needed NOW:</strong> Before standards ossify</li>
        </ul>
      </div>

      <div class="section">
        <h2>Key Properties</h2>
        <ul class="properties-list">
          <li>Infinite scalability: O(1) per-hop updates vs O(n) broadcast</li>
          <li>No inbound liquidity problem: credit + collateral hybrid</li>
          <li>Bounded risk: counterparty loss capped at collateral + credit</li>
          <li>Strong privacy: onion-routing (payment sender/receiver anonymous to routing hubs, like Tor for money)</li>
          <li><strong>Local state: no sequencers, no data availability dependencies</strong></li>
        </ul>
      </div>

      <!-- Triple-S First Principles -->
      <div class="section triple-s">
        <h2>Triple-S First Principles</h2>
        <div class="principles-grid">
          <div class="principle-card">
            <div class="principle-icon">⚡</div>
            <h3>Scalable</h3>
            <p><strong>Unicast (1-to-1)</strong> architecture enables unbounded horizontal scaling. No broadcast bottlenecks, no global consensus delays.</p>
            <p class="principle-detail">O(1) per-hop updates vs O(n) broadcast overhead. Counterparties self-select optimal routing paths through Coasian negotiation — from CBDCs to coffee, village to globe.</p>
            <p class="principle-detail">There is simply no other way to scale to the entire planet. The internet already proved unicast wins at global scale.</p>
          </div>
          <div class="principle-card">
            <div class="principle-icon">🔒</div>
            <h3>Secure</h3>
            <p><strong>Every phone and laptop will be a full node by default.</strong> Non-negotiable.</p>
            <p class="principle-detail">L1 blockchains handle only final netting — not every coffee purchase. This ultra-low settlement load means even phones can verify the entire chain. State pruning keeps storage minimal: full verification, not full history. No light clients, no trust assumptions.</p>
            <p class="principle-detail">This implements the original vision of Satoshi and Vitalik: self-sovereign verification without trusted intermediaries. Your keys, your node, your rules.</p>
          </div>
          <div class="principle-card">
            <div class="principle-icon">✨</div>
            <h3>Simple</h3>
            <p><strong>Banking 2.0</strong> with zero new terminology invented.</p>
            <p class="principle-detail">Credit, collateral, reserves, transfers. Concepts you already know. No zkSNARKs to understand, no merkle trees to audit. Just finance, but programmable.</p>
            <p class="principle-detail">Complexity hidden in the protocol. Simplicity exposed to users. That's how the internet scaled — and that's how finance will scale.</p>
          </div>
        </div>
      </div>

      <!-- Newsletter Signup -->
      <div class="newsletter-section">
        <div class="newsletter-header">
          <h3>Join the Unicast Revolution</h3>
          <p>Get notified about mainnet launch, technical deep-dives, and protocol updates</p>
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
            placeholder="your@email.com"
            required
            class="newsletter-input"
          />
          <button type="submit" class="newsletter-btn">
            Subscribe
          </button>
        </form>
        <p class="newsletter-note">No spam. Unsubscribe anytime. Privacy-first via Buttondown.</p>
      </div>

      <!-- Plot Twist -->
      <div class="section plot-twist">
        <h2>The Universal CBDC Substrate</h2>
        <p class="intro">xln isn't just "better payment channels" — it's the settlement layer for programmable money at planetary scale.</p>

        <div class="cbdc-stat">
          <div class="stat-stack">
            <div class="stat-number-large">137</div>
            <div class="stat-sublabel">countries</div>
          </div>
          <div class="stat-stack">
            <div class="stat-number-medium">72</div>
            <div class="stat-sublabel">in pilot phase</div>
          </div>
          <div class="stat-stack">
            <div class="stat-number-large">98%</div>
            <div class="stat-sublabel">of global GDP</div>
          </div>
          <div class="stat-description">
            building programmable ledgers (<a href="https://www.atlanticcouncil.org/cbdctracker/" target="_blank" rel="noopener noreferrer" class="stat-link">CBDCs</a>)
          </div>
        </div>

        <p class="vision-text">Most will be EVM-compatible or similar smart contract platforms. xln naturally attaches to <strong>any</strong> programmable ledger by simply deploying <code>Depository.sol</code>.</p>

        <div class="endgame-box">
          <p class="endgame-text"><strong>The endgame:</strong> xln becomes the universal CBDC substrate — every digital asset (CBDCs, stablecoins, tokenized securities, RWAs) gets instant off-chain settlement with bounded risk and infinite scale.</p>
          <p class="endgame-text">Zero broadcast overhead. Zero custody risk. Infinite horizontal scale.</p>
        </div>
      </div>
    </div>

    <div class="prompt-container">
      <!-- AI SUPERPROMPT -->
      <Collapsible title="AI Superprompt" bind:collapsed={comparativeCollapsed}>
        <div class="superprompt-section">
          <div class="superprompt-actions">
            <button on:click={copySuperprompt} class="copy-super-btn">
              {copiedCard === -2 ? '✓ Copied' : 'Copy Superprompt'}
            </button>
            <button on:click={() => showSubmitForm = !showSubmitForm} class="submit-toggle-btn">
              {showSubmitForm ? 'Hide Form' : 'Submit Results'}
            </button>
          </div>

          <p class="section-desc">Compare xln against the entire $100T finance stack — from TradFi/CEX to rollups</p>

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
                />
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
          <ComparativeChart />
        </div>
      </Collapsible>

      <div class="divider"></div>

      <!-- 10 EXPERT PROMPTS -->
      <Collapsible title="10 Expert Perspectives" bind:collapsed={promptsCollapsed}>
        <div class="prompt-section">
          <div class="prompt-header">
            <div class="prompt-label">
              <div class="label-subtitle">
                Prompt template: Read <a href="/c.txt" target="_blank" class="context-inline">https://xln.finance/c.txt</a> (~120k tokens of xln architecture + contracts + runtime)
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
                <div class="card-header" on:click={() => toggleCard(i)}>
                  <div class="persona-name">{prompt.persona}</div>
                  <div class="expand-icon">{expandedCard === i ? '−' : '+'}</div>
                </div>
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
          placeholder="Access Code"
          on:keydown={(e) => e.key === 'Enter' && handleSubmit()}
          class="invite-input"
        />
        <button on:click={handleSubmit} class="enter-btn">
          Unlock
        </button>
        {#if error}
          <div class="error">{error}</div>
        {/if}
        <p class="invite-note">DM @xlnfinance for access</p>
      </div>
    {/if}

    <div class="footer">
      <div class="context-highlight">
        <a href="/c.txt" target="_blank" class="context-link">
          <div class="context-header">
            <span class="context-icon">📄</span>
            <span class="context-title">xln.finance/c.txt</span>
          </div>
          <div class="context-desc">Complete source: All Solidity contracts + TypeScript runtime + Architecture docs (~120k tokens) — Context for AI analysis</div>
        </a>
      </div>

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

<style>
  @import url('https://fonts.googleapis.com/css2?family=JetBrains+Mono:wght@400;500;600&display=swap');

  .landing {
    min-height: 100vh;
    background: #000;
    color: #fff;
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    padding: 2rem;
    font-family: 'JetBrains Mono', 'Courier New', monospace;
  }

  .content {
    max-width: 900px;
    width: 100%;
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 3rem;
  }

  .logo {
    width: 400px;
    max-width: 80%;
    height: auto;
    filter: drop-shadow(0 0 20px rgba(255, 255, 255, 0.3));
    transition: filter 0.3s ease;
  }

  .landing.light-mode .logo {
    filter: invert(1) drop-shadow(0 0 20px rgba(0, 0, 0, 0.2));
  }

  /* Hero Tagline */
  .hero-tagline {
    text-align: center;
    margin: 2rem 0 1.5rem;
  }

  .hero-tagline h1 {
    font-size: 1.8rem;
    font-weight: 600;
    margin: 0 0 0.75rem;
    line-height: 1.3;
    background: linear-gradient(135deg, #4fd18b 0%, #00d1ff 100%);
    -webkit-background-clip: text;
    -webkit-text-fill-color: transparent;
    background-clip: text;
  }

  .hero-subtitle {
    font-size: 1rem;
    color: rgba(255, 255, 255, 0.7);
    margin: 0;
  }

  .landing.light-mode .hero-subtitle {
    color: rgba(0, 0, 0, 0.7);
  }

  /* Credibility Badge */
  .credibility-badge {
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    gap: 0.5rem;
    padding: 1rem 1.5rem;
    background: rgba(255, 255, 255, 0.03);
    border: 1px solid rgba(255, 255, 255, 0.15);
    border-radius: 8px;
    margin-bottom: 2rem;
    max-width: 600px;
    text-align: center;
  }

  .credibility-main {
    font-size: 0.95rem;
    font-weight: 600;
    color: rgba(255, 255, 255, 0.9);
  }

  .sakurity-link {
    color: #4fd18b;
    text-decoration: none;
    position: relative;
    font-weight: 600;
    transition: color 0.2s ease;
  }

  .sakurity-link::after {
    content: '';
    position: absolute;
    bottom: -2px;
    left: 0;
    width: 100%;
    height: 1px;
    background: #4fd18b;
    opacity: 0.4;
    transition: opacity 0.2s ease, transform 0.2s ease;
    transform: scaleX(0);
    transform-origin: left;
  }

  .sakurity-link:hover {
    color: #5fe19b;
  }

  .sakurity-link:hover::after {
    opacity: 1;
    transform: scaleX(1);
  }

  .credibility-sub {
    font-size: 0.8rem;
    color: rgba(255, 255, 255, 0.6);
  }

  .landing.light-mode .credibility-badge {
    background: rgba(0, 0, 0, 0.03);
    border-color: rgba(0, 0, 0, 0.15);
  }

  .landing.light-mode .credibility-main {
    color: rgba(0, 0, 0, 0.9);
  }

  .landing.light-mode .sakurity-link {
    color: #2a9d5f;
  }

  .landing.light-mode .sakurity-link::after {
    background: #2a9d5f;
  }

  .landing.light-mode .sakurity-link:hover {
    color: #1f8a50;
  }

  .landing.light-mode .credibility-sub {
    color: rgba(0, 0, 0, 0.6);
  }

  /* Urgency Section */
  .urgency-section {
    background: rgba(0, 209, 255, 0.05);
    border: 1px solid rgba(0, 209, 255, 0.2);
    border-radius: 8px;
    padding: 2rem;
    margin: 2rem 0;
  }

  .landing.light-mode .urgency-section {
    background: rgba(0, 122, 204, 0.05);
    border-color: rgba(0, 122, 204, 0.3);
  }

  .newsletter-section {
    width: 100%;
    max-width: 800px;
    margin: 3rem auto;
    padding: 2.5rem;
    background: rgba(79, 209, 139, 0.05);
    border: 1px solid rgba(79, 209, 139, 0.2);
    border-radius: 8px;
  }

  .newsletter-header {
    text-align: center;
    margin-bottom: 1.5rem;
  }

  .newsletter-header h3 {
    margin: 0 0 0.5rem;
    font-size: 1.3rem;
    font-weight: 600;
    color: #4fd18b;
  }

  .newsletter-header p {
    margin: 0;
    font-size: 0.9rem;
    color: rgba(255, 255, 255, 0.7);
    line-height: 1.5;
  }

  .newsletter-form {
    display: flex;
    flex-direction: row;
    gap: 0.75rem;
    width: 100%;
    align-items: stretch;
  }

  .newsletter-input {
    flex: 1 1 auto;
    height: 48px;
    padding: 0 1.25rem;
    background: rgba(0, 0, 0, 0.3);
    border: 1px solid rgba(255, 255, 255, 0.2);
    border-radius: 4px;
    color: #fff;
    font-family: 'JetBrains Mono', monospace;
    font-size: 0.9rem;
    line-height: 48px;
  }

  .newsletter-input::placeholder {
    color: rgba(255, 255, 255, 0.4);
  }

  .newsletter-input:focus {
    outline: none;
    border-color: rgba(79, 209, 139, 0.5);
    background: rgba(0, 0, 0, 0.4);
  }

  .newsletter-btn {
    flex: 0 0 auto;
    height: 48px;
    padding: 0 2.5rem;
    background: #4fd18b;
    border: none;
    border-radius: 4px;
    color: #000;
    font-family: 'JetBrains Mono', monospace;
    font-size: 0.9rem;
    font-weight: 600;
    cursor: pointer;
    transition: all 0.2s;
    white-space: nowrap;
    display: flex;
    align-items: center;
    justify-content: center;
  }

  .newsletter-btn:hover {
    background: #5fe19b;
    transform: translateY(-1px);
    box-shadow: 0 4px 12px rgba(79, 209, 139, 0.3);
  }

  .newsletter-note {
    margin: 1rem 0 0;
    font-size: 0.75rem;
    color: rgba(255, 255, 255, 0.5);
    text-align: center;
  }

  .invite-form {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 1rem;
    width: 100%;
    max-width: 400px;
    margin-top: 2rem;
    padding-top: 2rem;
    border-top: 1px solid rgba(255, 255, 255, 0.1);
  }

  .invite-label {
    font-size: 0.9rem;
    color: rgba(255, 255, 255, 0.5);
    text-transform: uppercase;
    letter-spacing: 0.1em;
  }

  .invite-input {
    width: 100%;
    padding: 1rem;
    background: rgba(255, 255, 255, 0.05);
    border: 1px solid rgba(255, 255, 255, 0.2);
    border-radius: 4px;
    color: #fff;
    font-family: 'JetBrains Mono', monospace;
    font-size: 1rem;
    text-align: center;
    text-transform: uppercase;
    letter-spacing: 0.2em;
  }

  .invite-input::placeholder {
    color: rgba(255, 255, 255, 0.3);
  }

  .invite-input:focus {
    outline: none;
    border-color: rgba(255, 255, 255, 0.5);
    background: rgba(255, 255, 255, 0.08);
  }

  .enter-btn {
    width: 100%;
    padding: 1rem;
    background: rgba(255, 255, 255, 0.1);
    border: 1px solid rgba(255, 255, 255, 0.3);
    border-radius: 4px;
    color: #fff;
    font-family: 'JetBrains Mono', monospace;
    font-size: 1rem;
    cursor: pointer;
    transition: all 0.2s;
  }

  .enter-btn:hover {
    background: rgba(255, 255, 255, 0.15);
    border-color: rgba(255, 255, 255, 0.5);
  }

  .error {
    color: #ff6b6b;
    font-size: 0.9rem;
    text-align: center;
  }

  .invite-note {
    margin-top: 0.75rem;
    font-size: 0.85rem;
    color: #888;
    text-align: center;
  }

  .problem-solution {
    width: 100%;
    max-width: 1200px;
    display: flex;
    flex-direction: column;
    gap: 3rem;
    margin-bottom: 4rem;
  }

  .section h2 {
    font-size: 1.5rem;
    font-weight: 600;
    margin-bottom: 1rem;
    color: rgba(255, 255, 255, 0.95);
  }

  .section .intro {
    font-size: 1rem;
    margin-bottom: 1rem;
    color: rgba(255, 255, 255, 0.8);
  }

  .vision-text {
    font-size: 1rem;
    line-height: 1.7;
    color: rgba(255, 255, 255, 0.8);
    margin-bottom: 1rem;
  }

  .section ul {
    list-style: none;
    padding: 0;
    display: flex;
    flex-direction: column;
    gap: 0.75rem;
    margin-top: 1rem;
  }

  .section li {
    padding-left: 1.5rem;
    position: relative;
    font-size: 0.95rem;
    line-height: 1.6;
    color: rgba(255, 255, 255, 0.75);
  }

  .section li::before {
    content: "•";
    position: absolute;
    left: 0;
    color: rgba(255, 255, 255, 0.4);
    font-weight: bold;
  }

  .section li strong {
    color: rgba(255, 255, 255, 0.9);
  }

  .footnote {
    font-size: 0.85rem;
    color: rgba(255, 255, 255, 0.4);
    margin-top: 1.5rem;
    font-style: italic;
  }

  .technical-context {
    margin-top: 2rem;
    padding-top: 2rem;
    border-top: 1px solid rgba(255, 255, 255, 0.1);
  }

  .formula-variants {
    display: flex;
    justify-content: center;
    align-items: center;
    gap: 2rem;
    margin: 2rem 0;
    flex-wrap: wrap;
  }

  .formula-box {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 0.75rem;
    padding: 1.5rem 2rem;
    background: rgba(79, 209, 139, 0.05);
    border: 1px solid rgba(79, 209, 139, 0.3);
    border-radius: 8px;
    min-width: 280px;
    transition: all 0.3s ease;
  }

  .formula-box:hover {
    background: rgba(79, 209, 139, 0.08);
    border-color: rgba(79, 209, 139, 0.5);
    box-shadow: 0 0 20px rgba(79, 209, 139, 0.2);
    transform: translateY(-2px);
  }

  .formula-label {
    font-size: 0.75rem;
    text-transform: uppercase;
    letter-spacing: 0.1em;
    color: rgba(255, 255, 255, 0.5);
  }

  .formula-math {
    font-size: 1.8rem;
    font-weight: 600;
    color: #4fd18b;
    font-family: 'JetBrains Mono', monospace;
    letter-spacing: 0.05em;
  }

  .formula-desc {
    font-size: 0.85rem;
    color: rgba(255, 255, 255, 0.6);
    text-align: center;
  }

  .formula-divider {
    font-size: 2rem;
    color: rgba(255, 255, 255, 0.4);
    font-weight: 300;
  }

  .formula-note {
    text-align: center;
    font-size: 0.85rem;
    color: rgba(255, 255, 255, 0.5);
    margin: -1rem 0 1.5rem;
    font-style: italic;
  }

  /* Triple-S First Principles */
  .triple-s {
    background: linear-gradient(135deg, rgba(79, 209, 139, 0.05) 0%, rgba(0, 122, 204, 0.05) 100%);
    border-radius: 12px;
    padding: 2.5rem;
  }

  .triple-s h2 {
    text-align: center;
    margin-bottom: 2.5rem;
    font-size: 2rem;
    background: linear-gradient(135deg, #4fd18b 0%, #007acc 100%);
    -webkit-background-clip: text;
    -webkit-text-fill-color: transparent;
    background-clip: text;
  }

  .principles-grid {
    display: grid;
    grid-template-columns: repeat(3, 1fr);
    gap: 2rem;
    margin-top: 1.5rem;
  }

  .principle-card {
    background: rgba(255, 255, 255, 0.02);
    border: 1px solid rgba(79, 209, 139, 0.2);
    border-radius: 8px;
    padding: 2rem;
    transition: all 0.3s ease;
  }

  .principle-card:hover {
    background: rgba(255, 255, 255, 0.04);
    border-color: rgba(79, 209, 139, 0.4);
    transform: translateY(-4px);
    box-shadow: 0 8px 24px rgba(79, 209, 139, 0.1);
  }

  .principle-icon {
    font-size: 3rem;
    text-align: center;
    margin-bottom: 1rem;
    filter: drop-shadow(0 0 8px rgba(79, 209, 139, 0.3));
  }

  .principle-card h3 {
    color: #4fd18b;
    font-size: 1.5rem;
    margin-bottom: 1rem;
    text-align: center;
    font-weight: 600;
  }

  .principle-card p {
    color: rgba(255, 255, 255, 0.85);
    line-height: 1.7;
    margin-bottom: 1rem;
    font-size: 0.95rem;
  }

  .principle-card p:last-child {
    margin-bottom: 0;
  }

  .principle-detail {
    color: rgba(255, 255, 255, 0.6);
    font-size: 0.9rem;
    line-height: 1.6;
  }

  .properties-list {
    list-style: none;
    padding: 0;
    display: flex;
    flex-direction: column;
    gap: 0.75rem;
    margin-top: 1rem;
  }

  .properties-list li {
    padding-left: 1.5rem;
    position: relative;
    font-size: 0.95rem;
    line-height: 1.6;
    color: rgba(255, 255, 255, 0.85);
  }

  .properties-list li::before {
    content: "✓";
    position: absolute;
    left: 0;
    color: #4fd18b;
    font-weight: bold;
  }

  .plot-twist {
    margin-top: 4rem;
    padding: 2rem;
    background: rgba(0, 209, 255, 0.03);
    border: 1px solid rgba(0, 209, 255, 0.2);
    border-radius: 8px;
  }

  .plot-twist h2 {
    color: #00d1ff;
    margin-bottom: 1rem;
  }

  .cbdc-stat {
    display: flex;
    flex-direction: row;
    justify-content: center;
    align-items: center;
    flex-wrap: wrap;
    gap: 3rem;
    margin: 2rem 0;
    padding: 2rem;
    background: rgba(0, 209, 255, 0.05);
    border-radius: 8px;
  }

  .stat-stack {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 0.5rem;
  }

  .stat-number-large {
    font-size: 3.5rem;
    font-weight: 700;
    color: #00d1ff;
    line-height: 1;
  }

  .stat-number-medium {
    font-size: 2.5rem;
    font-weight: 700;
    color: rgba(0, 209, 255, 0.8);
    line-height: 1;
  }

  .stat-sublabel {
    font-size: 0.85rem;
    color: rgba(255, 255, 255, 0.6);
    text-transform: uppercase;
    letter-spacing: 0.05em;
  }

  .stat-description {
    width: 100%;
    font-size: 0.95rem;
    color: rgba(255, 255, 255, 0.8);
    text-align: center;
    margin-top: 1rem;
  }

  .stat-link {
    color: #00d1ff;
    text-decoration: none;
    border-bottom: 1px solid rgba(0, 209, 255, 0.4);
    transition: all 0.2s;
  }

  .stat-link:hover {
    border-bottom-color: #00d1ff;
  }

  .plot-twist code {
    background: rgba(0, 0, 0, 0.4);
    padding: 0.2em 0.5em;
    border-radius: 3px;
    font-family: 'JetBrains Mono', monospace;
    color: #4fd18b;
    font-size: 0.95em;
  }

  .endgame-box {
    margin-top: 2rem;
    padding: 1.5rem;
    background: rgba(0, 0, 0, 0.3);
    border-left: 3px solid #00d1ff;
    border-radius: 4px;
  }

  .endgame-text {
    margin: 0 0 1rem;
    font-size: 1.05rem;
    line-height: 1.7;
    color: rgba(255, 255, 255, 0.9);
  }

  .endgame-text:last-child {
    margin-bottom: 0;
    font-style: italic;
    color: #00d1ff;
  }

  .invariant-box {
    margin: 2rem 0;
    padding: 1.5rem;
    background: rgba(79, 209, 139, 0.05);
    border: 1px solid rgba(79, 209, 139, 0.2);
    border-radius: 8px;
  }

  .tickers-grid {
    display: grid;
    grid-template-columns: 1fr auto;
    gap: 2rem;
    align-items: center;
  }

  .tickers-column {
    display: flex;
    flex-direction: column;
    gap: 1.5rem;
  }

  .visual-column {
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    min-width: 300px;
    gap: 0.75rem;
  }

  .rcpan-visual {
    width: 85%;
    max-width: 340px;
    height: auto;
    display: block;
    filter: drop-shadow(0 0 20px rgba(79, 209, 139, 0.3));
    transition: filter 0.3s ease;
  }

  .rcpan-visual:hover {
    filter: drop-shadow(0 0 30px rgba(79, 209, 139, 0.5));
  }

  .visual-caption {
    font-size: 0.8rem;
    color: rgba(255, 255, 255, 0.6);
    text-align: center;
    font-style: italic;
    max-width: 340px;
  }

  .visualization-link-section {
    width: 100%;
    max-width: 800px;
    margin: 2rem 0;
  }

  .viz-link-card {
    display: block;
    padding: 2rem;
    background: rgba(255, 255, 255, 0.03);
    border: 1px solid rgba(255, 255, 255, 0.15);
    border-radius: 8px;
    text-decoration: none;
    transition: all 0.3s ease;
  }

  .viz-link-card:hover {
    background: rgba(255, 255, 255, 0.05);
    border-color: rgba(79, 209, 139, 0.4);
    transform: translateY(-2px);
    box-shadow: 0 4px 20px rgba(79, 209, 139, 0.15);
  }

  .viz-link-header {
    display: flex;
    justify-content: space-between;
    align-items: center;
    margin-bottom: 0.5rem;
  }

  .viz-link-header h3 {
    margin: 0;
    font-size: 1.2rem;
    font-weight: 600;
    color: #fff;
  }

  .arrow {
    font-size: 1.5rem;
    color: rgba(79, 209, 139, 0.6);
    transition: transform 0.3s ease;
  }

  .viz-link-card:hover .arrow {
    transform: translateX(5px);
    color: rgba(79, 209, 139, 1);
  }

  .viz-link-desc {
    margin: 0;
    font-size: 0.95rem;
    color: rgba(255, 255, 255, 0.6);
    line-height: 1.6;
  }

  @media (max-width: 1024px) {
    .tickers-grid {
      grid-template-columns: 1fr;
    }

    .visual-column {
      margin-top: 1rem;
    }

    .principles-grid {
      grid-template-columns: repeat(2, 1fr);
    }
  }

  .prompt-container {
    width: 100%;
    max-width: 1400px;
    display: flex;
    flex-direction: column;
    gap: 2rem;
  }

  .superprompt-section {
    padding: 2rem 0;
  }

  .prompt-section {
    padding: 2rem 0;
  }

  .section-desc {
    font-size: 0.95rem;
    color: rgba(255, 255, 255, 0.7);
    margin: 0 0 1.5rem;
    line-height: 1.6;
  }

  .superprompt-header {
    display: flex;
    justify-content: space-between;
    align-items: flex-start;
    gap: 2rem;
    flex-wrap: wrap;
    margin-bottom: 1.5rem;
  }

  .superprompt-header h2 {
    font-size: 1.4rem;
    font-weight: 600;
    margin: 0 0 0.5rem;
    color: #4fd18b;
  }

  .superprompt-header p {
    font-size: 0.9rem;
    color: rgba(255, 255, 255, 0.7);
    margin: 0;
  }

  .superprompt-actions {
    display: flex;
    gap: 1rem;
    flex-wrap: wrap;
  }

  .copy-super-btn, .submit-toggle-btn {
    padding: 0.75rem 1.5rem;
    background: rgba(255, 255, 255, 0.1);
    border: 1px solid rgba(255, 255, 255, 0.3);
    border-radius: 4px;
    color: #fff;
    font-family: 'JetBrains Mono', monospace;
    font-size: 0.85rem;
    cursor: pointer;
    transition: all 0.2s;
    white-space: nowrap;
  }

  .copy-super-btn:hover, .submit-toggle-btn:hover {
    background: rgba(255, 255, 255, 0.15);
    border-color: rgba(255, 255, 255, 0.5);
  }

  .submit-form {
    display: flex;
    flex-direction: column;
    gap: 1rem;
    margin-top: 1.5rem;
    padding-top: 1.5rem;
    border-top: 1px solid rgba(255, 255, 255, 0.1);
  }

  .form-row {
    display: flex;
    flex-direction: column;
  }

  .form-input, .form-textarea {
    width: 100%;
    padding: 0.75rem;
    background: rgba(0, 0, 0, 0.3);
    border: 1px solid rgba(255, 255, 255, 0.2);
    border-radius: 4px;
    color: #fff;
    font-family: 'JetBrains Mono', monospace;
    font-size: 0.85rem;
  }

  .form-input::placeholder, .form-textarea::placeholder {
    color: rgba(255, 255, 255, 0.3);
  }

  .form-input:focus, .form-textarea:focus {
    outline: none;
    border-color: rgba(255, 255, 255, 0.4);
    background: rgba(0, 0, 0, 0.4);
  }

  .form-textarea {
    line-height: 1.5;
    resize: vertical;
  }

  .submit-btn {
    align-self: flex-start;
    padding: 0.75rem 2rem;
    background: #4fd18b;
    border: none;
    border-radius: 4px;
    color: #000;
    font-family: 'JetBrains Mono', monospace;
    font-size: 0.9rem;
    font-weight: 600;
    cursor: pointer;
    transition: all 0.2s;
  }

  .submit-btn:hover {
    background: #5fe19b;
    transform: translateY(-1px);
  }

  .submission-status {
    padding: 0.75rem;
    background: rgba(255, 255, 255, 0.05);
    border-radius: 4px;
    font-size: 0.9rem;
    text-align: center;
  }

  .submit-note {
    font-size: 0.8rem;
    color: rgba(255, 255, 255, 0.5);
    margin: 0;
  }

  .superprompt-preview {
    margin-top: 1.5rem;
    display: flex;
    flex-direction: column;
    gap: 0.5rem;
  }

  .preview-label {
    font-size: 0.85rem;
    color: rgba(255, 255, 255, 0.6);
    font-weight: 500;
  }

  .preview-text {
    width: 100%;
    padding: 1rem;
    background: rgba(0, 0, 0, 0.4);
    border: 1px solid rgba(255, 255, 255, 0.15);
    border-radius: 6px;
    color: rgba(255, 255, 255, 0.8);
    font-family: 'JetBrains Mono', monospace;
    font-size: 0.75rem;
    line-height: 1.6;
    resize: vertical;
    cursor: text;
  }

  .preview-text:focus {
    outline: none;
    border-color: rgba(255, 255, 255, 0.3);
  }

  .divider {
    width: 100%;
    height: 1px;
    background: rgba(255, 255, 255, 0.1);
    margin: 2rem 0;
  }

  .prompt-container {
    width: 100%;
    max-width: 1400px;
    display: flex;
    flex-direction: column;
    gap: 2rem;
  }

  .prompt-header {
    display: flex;
    justify-content: space-between;
    align-items: flex-start;
    gap: 2rem;
    flex-wrap: wrap;
  }

  .prompt-label {
    flex: 1;
    min-width: 300px;
  }

  .label-title {
    font-size: 1.1rem;
    font-weight: 600;
    margin-bottom: 0.75rem;
    color: rgba(255, 255, 255, 0.95);
  }

  .label-subtitle {
    font-size: 0.9rem;
    line-height: 1.7;
    color: rgba(255, 255, 255, 0.6);
  }

  .context-inline {
    color: rgba(255, 255, 255, 0.8);
    text-decoration: none;
    border-bottom: 1px solid rgba(255, 255, 255, 0.3);
    transition: all 0.2s;
  }

  .context-inline:hover {
    color: rgba(255, 255, 255, 1);
    border-bottom-color: rgba(255, 255, 255, 0.8);
  }

  .copy-all-btn {
    padding: 0.75rem 1.5rem;
    background: rgba(255, 255, 255, 0.1);
    border: 1px solid rgba(255, 255, 255, 0.3);
    border-radius: 4px;
    color: #fff;
    font-family: 'JetBrains Mono', monospace;
    font-size: 0.85rem;
    cursor: pointer;
    transition: all 0.2s;
    white-space: nowrap;
  }

  .copy-all-btn:hover {
    background: rgba(255, 255, 255, 0.15);
    border-color: rgba(255, 255, 255, 0.5);
  }

  .prompt-grid {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(400px, 1fr));
    gap: 1rem;
    width: 100%;
  }

  .prompt-card {
    background: rgba(255, 255, 255, 0.03);
    border: 1px solid rgba(255, 255, 255, 0.1);
    border-radius: 8px;
    overflow: hidden;
    transition: all 0.2s;
  }

  .prompt-card:hover {
    border-color: rgba(255, 255, 255, 0.2);
    box-shadow: 0 4px 12px rgba(255, 255, 255, 0.05);
  }

  .prompt-card.expanded {
    border-color: rgba(255, 255, 255, 0.3);
  }

  .card-header {
    display: flex;
    justify-content: space-between;
    align-items: center;
    padding: 1rem 1.25rem;
    cursor: pointer;
    user-select: none;
  }

  .card-header:hover {
    background: rgba(255, 255, 255, 0.02);
  }

  .persona-name {
    font-weight: 500;
    font-size: 0.95rem;
    color: rgba(255, 255, 255, 0.9);
  }

  .expand-icon {
    font-size: 1.2rem;
    color: rgba(255, 255, 255, 0.5);
    font-weight: 300;
  }

  .card-content {
    padding: 0 1.25rem 1.25rem;
    display: flex;
    flex-direction: column;
    gap: 1rem;
  }

  .prompt-text {
    background: rgba(0, 0, 0, 0.3);
    border: 1px solid rgba(255, 255, 255, 0.1);
    border-radius: 4px;
    padding: 1rem;
    font-family: 'JetBrains Mono', monospace;
    font-size: 0.8rem;
    line-height: 1.7;
    color: rgba(255, 255, 255, 0.85);
    white-space: pre-wrap;
    word-wrap: break-word;
    margin: 0;
  }

  .copy-btn {
    align-self: flex-end;
    padding: 0.5rem 1rem;
    background: rgba(255, 255, 255, 0.08);
    border: 1px solid rgba(255, 255, 255, 0.2);
    border-radius: 4px;
    color: #fff;
    font-family: 'JetBrains Mono', monospace;
    font-size: 0.8rem;
    cursor: pointer;
    transition: all 0.2s;
  }

  .copy-btn:hover {
    background: rgba(255, 255, 255, 0.12);
    border-color: rgba(255, 255, 255, 0.3);
  }

  .footer {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 1.5rem;
    font-size: 0.85rem;
    margin-top: 4rem;
  }

  .context-highlight {
    width: 100%;
    max-width: 700px;
  }

  .context-link {
    display: block;
    padding: 1.5rem 2rem;
    background: rgba(79, 209, 139, 0.08);
    border: 2px solid rgba(79, 209, 139, 0.3);
    border-radius: 8px;
    text-decoration: none;
    transition: all 0.3s ease;
  }

  .context-link:hover {
    background: rgba(79, 209, 139, 0.12);
    border-color: rgba(79, 209, 139, 0.5);
    transform: translateY(-2px);
    box-shadow: 0 4px 20px rgba(79, 209, 139, 0.2);
  }

  .context-header {
    display: flex;
    align-items: center;
    gap: 0.75rem;
    margin-bottom: 0.5rem;
  }

  .context-icon {
    font-size: 1.5rem;
  }

  .context-title {
    font-size: 1.2rem;
    font-weight: 600;
    color: #4fd18b;
    font-family: 'JetBrains Mono', monospace;
  }

  .context-desc {
    font-size: 0.9rem;
    color: rgba(255, 255, 255, 0.8);
    line-height: 1.6;
    margin: 0;
  }

  .footer-links {
    display: flex;
    flex-wrap: wrap;
    justify-content: center;
    align-items: center;
    gap: 1rem;
  }

  .footer-link {
    color: rgba(255, 255, 255, 0.6);
    text-decoration: none;
    transition: color 0.2s;
  }

  .footer-link:hover {
    color: rgba(255, 255, 255, 0.9);
  }

  .separator {
    color: rgba(255, 255, 255, 0.2);
  }

  .tagline {
    text-align: center;
    color: rgba(255, 255, 255, 0.4);
  }

  /* Light mode overrides - comprehensive */
  .landing.light-mode {
    background: #fff;
    color: #000;
  }

  .landing.light-mode *:not(.control-btn) {
    color: inherit;
  }

  .landing.light-mode h2,
  .landing.light-mode .intro,
  .landing.light-mode .vision-text,
  .landing.light-mode li,
  .landing.light-mode .section li,
  .landing.light-mode .properties-list li {
    color: rgba(0, 0, 0, 0.85);
  }

  .landing.light-mode .section li::before {
    color: rgba(0, 0, 0, 0.4);
  }

  .landing.light-mode .properties-list li::before {
    color: #2a9d5f;
  }

  .landing.light-mode .formula-box {
    background: rgba(79, 209, 139, 0.1);
    border-color: rgba(79, 209, 139, 0.4);
  }

  .landing.light-mode .formula-math {
    color: #2a9d5f;
  }

  .landing.light-mode .newsletter-section {
    background: rgba(79, 209, 139, 0.08);
    border-color: rgba(79, 209, 139, 0.3);
  }

  .landing.light-mode .newsletter-input {
    background: rgba(0, 0, 0, 0.05);
    border-color: rgba(0, 0, 0, 0.2);
    color: #000;
  }

  .landing.light-mode .newsletter-input::placeholder {
    color: rgba(0, 0, 0, 0.4);
  }

  .landing.light-mode .invite-input {
    background: rgba(0, 0, 0, 0.05);
    border-color: rgba(0, 0, 0, 0.2);
    color: #000;
  }

  .landing.light-mode .invite-input::placeholder {
    color: rgba(0, 0, 0, 0.3);
  }

  .landing.light-mode .enter-btn {
    background: rgba(0, 0, 0, 0.1);
    border-color: rgba(0, 0, 0, 0.3);
    color: #000;
  }

  .landing.light-mode .enter-btn:hover {
    background: rgba(0, 0, 0, 0.15);
    border-color: rgba(0, 0, 0, 0.5);
  }

  .landing.light-mode .principle-card {
    background: rgba(0, 0, 0, 0.02);
    border-color: rgba(79, 209, 139, 0.3);
  }

  .landing.light-mode .principle-card:hover {
    background: rgba(0, 0, 0, 0.04);
  }

  .landing.light-mode .principle-card h3 {
    color: #2a9d5f;
  }

  .landing.light-mode .principle-card p {
    color: rgba(0, 0, 0, 0.85);
  }

  .landing.light-mode .principle-detail {
    color: rgba(0, 0, 0, 0.6);
  }

  .landing.light-mode .endgame-box {
    background: rgba(0, 0, 0, 0.05);
    border-left-color: #007acc;
  }

  .landing.light-mode .endgame-text {
    color: rgba(0, 0, 0, 0.85);
  }

  .landing.light-mode .endgame-text:last-child {
    color: #007acc;
  }

  .landing.light-mode .plot-twist {
    background: rgba(0, 122, 204, 0.05);
    border-color: rgba(0, 122, 204, 0.3);
  }

  .landing.light-mode .plot-twist h2 {
    color: #007acc;
  }

  .landing.light-mode .cbdc-stat {
    background: rgba(0, 122, 204, 0.08);
  }

  .landing.light-mode .stat-number-large {
    color: #007acc;
  }

  .landing.light-mode .stat-number-medium {
    color: rgba(0, 122, 204, 0.8);
  }

  .landing.light-mode .stat-sublabel,
  .landing.light-mode .stat-description {
    color: rgba(0, 0, 0, 0.7);
  }

  .landing.light-mode .stat-link {
    color: #007acc;
    border-bottom-color: rgba(0, 122, 204, 0.4);
  }

  .landing.light-mode .stat-link:hover {
    border-bottom-color: #007acc;
  }

  .landing.light-mode code {
    background: rgba(0, 0, 0, 0.08);
    color: #2a9d5f;
  }

  .landing.light-mode .context-link {
    background: rgba(79, 209, 139, 0.12);
    border-color: rgba(79, 209, 139, 0.4);
  }

  .landing.light-mode .context-link:hover {
    background: rgba(79, 209, 139, 0.18);
    border-color: rgba(79, 209, 139, 0.6);
  }

  .landing.light-mode .context-title {
    color: #2a9d5f;
  }

  .landing.light-mode .context-desc {
    color: rgba(0, 0, 0, 0.75);
  }

  .landing.light-mode .footer-link {
    color: rgba(0, 0, 0, 0.6);
  }

  .landing.light-mode .footer-link:hover {
    color: rgba(0, 0, 0, 0.9);
  }

  .landing.light-mode .separator {
    color: rgba(0, 0, 0, 0.2);
  }

  .landing.light-mode .tagline {
    color: rgba(0, 0, 0, 0.4);
  }

  .landing.light-mode .prompt-card {
    background: rgba(0, 0, 0, 0.03);
    border-color: rgba(0, 0, 0, 0.15);
  }

  .landing.light-mode .prompt-card:hover {
    border-color: rgba(0, 0, 0, 0.25);
    box-shadow: 0 4px 12px rgba(0, 0, 0, 0.08);
  }

  .landing.light-mode .prompt-card.expanded {
    border-color: rgba(0, 0, 0, 0.3);
  }

  .landing.light-mode .card-header:hover {
    background: rgba(0, 0, 0, 0.02);
  }

  .landing.light-mode .persona-name {
    color: rgba(0, 0, 0, 0.9);
  }

  .landing.light-mode .expand-icon {
    color: rgba(0, 0, 0, 0.5);
  }

  .landing.light-mode .prompt-text {
    background: rgba(0, 0, 0, 0.05);
    border-color: rgba(0, 0, 0, 0.15);
    color: rgba(0, 0, 0, 0.85);
  }

  .landing.light-mode .copy-btn,
  .landing.light-mode .copy-all-btn,
  .landing.light-mode .copy-super-btn,
  .landing.light-mode .submit-toggle-btn {
    background: rgba(0, 0, 0, 0.08);
    border-color: rgba(0, 0, 0, 0.2);
    color: #000;
  }

  .landing.light-mode .copy-btn:hover,
  .landing.light-mode .copy-all-btn:hover,
  .landing.light-mode .copy-super-btn:hover,
  .landing.light-mode .submit-toggle-btn:hover {
    background: rgba(0, 0, 0, 0.12);
    border-color: rgba(0, 0, 0, 0.3);
  }

  .landing.light-mode .label-subtitle,
  .landing.light-mode .section-desc {
    color: rgba(0, 0, 0, 0.6);
  }

  .landing.light-mode .context-inline {
    color: rgba(0, 0, 0, 0.8);
    border-bottom-color: rgba(0, 0, 0, 0.3);
  }

  .landing.light-mode .context-inline:hover {
    color: rgba(0, 0, 0, 1);
    border-bottom-color: rgba(0, 0, 0, 0.8);
  }

  .landing.light-mode .form-input,
  .landing.light-mode .form-textarea {
    background: rgba(0, 0, 0, 0.05);
    border-color: rgba(0, 0, 0, 0.2);
    color: #000;
  }

  .landing.light-mode .form-input::placeholder,
  .landing.light-mode .form-textarea::placeholder {
    color: rgba(0, 0, 0, 0.3);
  }

  .landing.light-mode .form-input:focus,
  .landing.light-mode .form-textarea:focus {
    border-color: rgba(0, 0, 0, 0.4);
    background: rgba(0, 0, 0, 0.08);
  }

  .landing.light-mode .preview-text {
    background: rgba(0, 0, 0, 0.08);
    border-color: rgba(0, 0, 0, 0.15);
    color: rgba(0, 0, 0, 0.8);
  }

  .landing.light-mode .preview-text:focus {
    border-color: rgba(0, 0, 0, 0.3);
  }

  .landing.light-mode .preview-label {
    color: rgba(0, 0, 0, 0.6);
  }

  .landing.light-mode .submit-note {
    color: rgba(0, 0, 0, 0.5);
  }

  .landing.light-mode .divider {
    background: rgba(0, 0, 0, 0.1);
  }

  .landing.light-mode .invite-label {
    color: rgba(0, 0, 0, 0.5);
  }

  .landing.light-mode .invite-note {
    color: rgba(0, 0, 0, 0.5);
  }

  .landing.light-mode .error {
    color: #cc0000;
  }

  .landing.light-mode .newsletter-header h3 {
    color: #2a9d5f;
  }

  .landing.light-mode .newsletter-header p {
    color: rgba(0, 0, 0, 0.7);
  }

  .landing.light-mode .newsletter-note {
    color: rgba(0, 0, 0, 0.5);
  }

  .landing.light-mode .technical-context {
    border-top-color: rgba(0, 0, 0, 0.1);
  }

  .landing.light-mode .triple-s {
    background: linear-gradient(135deg, rgba(79, 209, 139, 0.08) 0%, rgba(0, 122, 204, 0.08) 100%);
  }

  .landing.light-mode .triple-s h2 {
    background: linear-gradient(135deg, #2a9d5f 0%, #007acc 100%);
    -webkit-background-clip: text;
    -webkit-text-fill-color: transparent;
    background-clip: text;
  }

  .landing.light-mode .invariant-box {
    background: rgba(79, 209, 139, 0.08);
    border-color: rgba(79, 209, 139, 0.3);
  }

  .landing.light-mode .formula-divider {
    color: rgba(0, 0, 0, 0.4);
  }

  .landing.light-mode .formula-label {
    color: rgba(0, 0, 0, 0.5);
  }

  .landing.light-mode .formula-desc {
    color: rgba(0, 0, 0, 0.6);
  }

  @keyframes pulse {
    0% { transform: scale(1); }
    50% { transform: scale(1.05); box-shadow: 0 0 20px rgba(79, 209, 139, 0.5); }
    100% { transform: scale(1); }
  }

  @media (max-width: 768px) {
    .logo {
      width: 300px;
    }

    .newsletter-form {
      flex-direction: column;
    }

    .newsletter-input {
      width: 100%;
    }

    .newsletter-btn {
      width: 100%;
    }

    .principles-grid {
      grid-template-columns: 1fr;
      gap: 1.5rem;
    }

    .triple-s {
      padding: 1.5rem;
    }

    .principle-card {
      padding: 1.5rem;
    }

    .prompt-grid {
      grid-template-columns: 1fr;
    }

    .prompt-header {
      flex-direction: column;
      align-items: stretch;
    }

    .copy-all-btn {
      width: 100%;
    }

    .prompt-text {
      font-size: 0.75rem;
      padding: 0.75rem;
    }

    .label-title {
      font-size: 1rem;
    }

    .label-subtitle {
      font-size: 0.85rem;
    }

    .properties-grid {
      grid-template-columns: 1fr;
    }
  }
</style>
