<script lang="ts">
  import { onMount } from 'svelte';
  import { browser } from '$app/environment';
  import ComparativeChart from './ComparativeChart.svelte';

  export let onUnlock: () => void;

  let inviteCode = '';
  let error = '';
  let expandedCard: number | null = null;
  let copiedCard: number | null = null;

  let showSubmitForm = false;
  let submissionText = '';
  let shareUrl = '';
  let submissionStatus = '';
  let superpromptText = '';
  let showInvite = true;

  const SUPERPROMPT = {
    persona: "ULTIMATE COMPARATIVE ANALYSIS",
    task: "Compare XLN against all major payment solutions (CEX, Lightning, Raiden, Plasma, Optimistic/ZK Rollups, Sharding, Big Blocks) across 6 dimensions. Output machine-parseable table with rankings.",
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

      // Check for #MML hash
      if (window.location.hash === '#MML') {
        localStorage.setItem('open', 'true');
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

<div class="landing">
  <div class="content">
    <img src="/img/logo.png" alt="XLN" class="logo" />

    <div class="skip-link-container">
      <a href="/#MML" class="skip-link" on:click|preventDefault={() => { localStorage.setItem('open', 'true'); onUnlock(); }}>
        Skip to testnet →
      </a>
    </div>

    <div class="problem-solution">
      <div class="section">
        <h2>The $100 Trillion Question</h2>
        <p class="intro">How do we scale finance without custodians?</p>
        <p class="vision-text">Every existing answer fails at planetary scale:</p>
        <ul>
          <li><strong>TradFi/CEX (traditional banks, Binance, Coinbase):</strong> $100T economy, $10T daily volume, but custodial — bank bailouts, FTX collapse, Mt. Gox</li>
          <li><strong>Big Blockers (Solana, Tron):</strong> $80B market cap, but can't run full nodes — centralized by design</li>
          <li><strong>Rollups (Arbitrum, zkSync):</strong> $10B+ TVL, but data availability paradox — trust committees or die</li>
          <li><strong>Sharding (Eth roadmap):</strong> Still broadcast O(n) — doesn't solve the fundamental bottleneck</li>
        </ul>
        <p class="footnote">Historical footnotes: Lightning/Raiden/Plasma (all dead due to full-reserve constraints)</p>
      </div>

      <div class="section">
        <h2>The First Credible Alternative</h2>
        <p class="formula">Δ ≤ R + C</p>
        <p class="formula-explain">(Delta ≤ Reserves + Credit)</p>
        <p class="intro">What if TradFi/CEX was cryptographically provable?</p>
        <p class="vision-text">The RCPAN invariant: Unicast architecture (O(1) like banking) + cryptographic proofs (like blockchain) + mechanical enforcement (no bailouts).</p>
        <p class="vision-text"><strong>xln: The only architecture that scales to $100T without sacrificing decentralization.</strong></p>
      </div>

      <div class="section">
        <h2>What This Unlocks</h2>
        <div class="properties-grid">
          <div class="property">
            <span class="prop-icon">🌍</span>
            <div>
              <strong>Planetary scale</strong>
              <span>Unbounded TPS via unicast O(1), not broadcast O(n)</span>
            </div>
          </div>
          <div class="property">
            <span class="prop-icon">💰</span>
            <div>
              <strong>Credit + Reserves</strong>
              <span>Capital efficiency of TradFi/CEX, security of blockchain</span>
            </div>
          </div>
          <div class="property">
            <span class="prop-icon">⚖️</span>
            <div>
              <strong>Bailout-free</strong>
              <span>enforceDebts() FIFO queue, mechanical liquidation</span>
            </div>
          </div>
          <div class="property">
            <span class="prop-icon">🔐</span>
            <div>
              <strong>Cryptographic proofs</strong>
              <span>Account proofs enable unilateral exit anytime</span>
            </div>
          </div>
          <div class="property">
            <span class="prop-icon">📱</span>
            <div>
              <strong>Consumer hardware</strong>
              <span>Full node on laptop/phone — no 1TB SSD requirements</span>
            </div>
          </div>
          <div class="property">
            <span class="prop-icon">⚡</span>
            <div>
              <strong>Instant settlement</strong>
              <span>Sub-second finality, not 12-second blocks</span>
            </div>
          </div>
        </div>
      </div>
    </div>

    <div class="prompt-container">
      <!-- SUPERPROMPT -->
      <div class="superprompt-section">
        <div class="superprompt-header">
          <div>
            <h2>Ultimate Comparative Analysis</h2>
            <p>Compare xln against the entire $100T finance stack — from TradFi/CEX to rollups</p>
          </div>
          <div class="superprompt-actions">
            <button on:click={copySuperprompt} class="copy-super-btn">
              {copiedCard === -2 ? '✓ Copied' : 'Copy Superprompt'}
            </button>
            <button on:click={() => showSubmitForm = !showSubmitForm} class="submit-toggle-btn">
              {showSubmitForm ? 'Hide Form' : 'Submit Results'}
            </button>
          </div>
        </div>

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

      <div class="divider"></div>

      <!-- 10 EXPERT PROMPTS -->
      <div class="prompt-header">
        <div class="prompt-label">
          <div class="label-title">10 Expert Perspectives</div>
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

    {#if showInvite}
      <div class="invite-form">
        <div class="invite-label">Early Access</div>
        <input
          type="text"
          bind:value={inviteCode}
          placeholder="Invite Code"
          on:keydown={(e) => e.key === 'Enter' && handleSubmit()}
          class="invite-input"
        />
        <button on:click={handleSubmit} class="enter-btn">
          Enter Testnet
        </button>
        {#if error}
          <div class="error">{error}</div>
        {/if}
      </div>
    {/if}

    <div class="footer">
      <div class="footer-links">
        <a href="/c.txt" target="_blank" class="footer-link">xln.finance/c.txt</a>
        <span class="separator">·</span>
        <a href="https://x.com/xlnfinance" target="_blank" rel="noopener noreferrer" class="footer-link">x.com/xlnfinance</a>
        <span class="separator">·</span>
        <a href="https://github.com/xlnfinance/xln" target="_blank" rel="noopener noreferrer" class="footer-link">github.com/xlnfinance/xln</a>
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
  }

  .skip-link-container {
    margin-bottom: 3rem;
  }

  .skip-link {
    color: rgba(255, 255, 255, 0.5);
    text-decoration: none;
    font-size: 0.9rem;
    transition: all 0.2s;
    border-bottom: 1px solid transparent;
  }

  .skip-link:hover {
    color: rgba(255, 255, 255, 0.9);
    border-bottom-color: rgba(255, 255, 255, 0.5);
  }

  .invite-form {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 1rem;
    width: 100%;
    max-width: 400px;
    margin-top: 4rem;
    padding-top: 3rem;
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

  .formula {
    font-size: 2rem;
    font-weight: 600;
    text-align: center;
    margin: 1rem 0 0.5rem;
    color: #4fd18b;
    letter-spacing: 0.05em;
  }

  .formula-explain {
    text-align: center;
    font-size: 0.9rem;
    color: rgba(255, 255, 255, 0.5);
    margin-bottom: 1.5rem;
  }

  .properties-grid {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(280px, 1fr));
    gap: 1rem;
    margin-top: 1rem;
  }

  .property {
    display: flex;
    gap: 1rem;
    align-items: flex-start;
    padding: 1rem;
    background: rgba(255, 255, 255, 0.03);
    border: 1px solid rgba(255, 255, 255, 0.1);
    border-radius: 8px;
    transition: all 0.2s;
  }

  .property:hover {
    background: rgba(255, 255, 255, 0.05);
    border-color: rgba(255, 255, 255, 0.2);
  }

  .prop-icon {
    font-size: 1.5rem;
    flex-shrink: 0;
  }

  .property div {
    display: flex;
    flex-direction: column;
    gap: 0.25rem;
  }

  .property strong {
    font-size: 0.95rem;
    color: rgba(255, 255, 255, 0.95);
  }

  .property span {
    font-size: 0.85rem;
    color: rgba(255, 255, 255, 0.6);
    line-height: 1.4;
  }

  .prompt-container {
    width: 100%;
    max-width: 1400px;
    display: flex;
    flex-direction: column;
    gap: 2rem;
  }

  .superprompt-section {
    background: rgba(255, 255, 255, 0.05);
    border: 2px solid rgba(255, 255, 255, 0.2);
    border-radius: 12px;
    padding: 2rem;
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
    gap: 0.75rem;
    font-size: 0.85rem;
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

  @keyframes pulse {
    0% { transform: scale(1); }
    50% { transform: scale(1.05); box-shadow: 0 0 20px rgba(79, 209, 139, 0.5); }
    100% { transform: scale(1); }
  }

  @media (max-width: 768px) {
    .logo {
      width: 300px;
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
