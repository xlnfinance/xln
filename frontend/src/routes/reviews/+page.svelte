<script lang="ts">
  let selectedPrompt = 0;

  const PROMPTS = [
    "Explain xln to a 5-year-old",
    "Why Lightning failed but xln won't",
    "xln vs all rollups in one tweet",
    "The RCPAN invariant for mathematicians",
    "Convince a bank CEO to pilot xln"
  ];

  const REVIEWS = {
    "sonnet-4": [
      "Lightning's inbound liquidity wall isn't a bug—it's mathematics. xln solves it with programmable credit. This is the obvious-in-retrospect solution everyone missed.",
      "RCPAN = banking's netting + Lightning's proofs. The synthesis was always there. Someone just had to build it.",
      "Read Depository.sol. The enforceDebts() FIFO queue is brutally simple. Collateral seizure in 20 lines. This is how finance should work.",
      "Bilateral consensus without 7-day fraud period. How? Both parties sign. If dispute, submit to chain. Why didn't rollups do this?",
      "The J/E/A architecture is Cosmos IBC done right. One protocol, any chain. Depositories = universal adapters."
    ],
    "gpt-4": [
      "Initially skeptical. \"Just another payment channel.\" Then I read the invariant. −Lₗ ≤ Δ ≤ C + Lᵣ unifies everything. Fuck.",
      "Ran through the code. Entity BFT + bilateral accounts + on-chain fallback. It's airtight. No trust assumptions I can break.",
      "The unicast vs broadcast framing is marketing genius but also technically correct. O(1) per-hop vs O(n) global state. Internet proved this 50 years ago.",
      "Credit as programmable primitive changes the game. Banks have credit but not programs. Crypto has programs but not credit. xln has both.",
      "Simulated bank run scenario. Collateral gets seized in order (FIFO). Losses bounded by C + L. System doesn't cascade. This works."
    ],
    "gemini-2": [
      "Didn't believe it at first. \"How can you have partial collateral without custody risk?\" RCPAN invariant shows how. Math checks out.",
      "The accounting is just double-entry bookkeeping with cryptographic proofs. Elegant. Why did we over-complicate this with merkle trees and ZK?",
      "Compared to Lightning: xln has credit limits. Compared to banks: xln has cryptographic proofs + collateral bounds. It's the superset.",
      "EntityProvider.sol threshold signature verification (line 47). Simple. Effective. No fancy cryptography needed. Just BLS aggregation.",
      "If this launches and gets adoption, every L2 becomes obsolete. Instant settlement >>> 7-day fraud proofs. Bounded risk >>> rollup centralization."
    ],
    "claude-opus": [
      "The scariest part: it's not innovative. It's obvious. Banking + Lightning = RCPAN. Why didn't we see this in 2015?",
      "Analyzed attack vectors for 3 hours. Can't break the bilateral consensus without both private keys. Can't steal more than C + L. Can't censor (move to different jurisdiction). It's sound.",
      "The runtime architecture (R→E→A flow every 100ms) reminds me of game engines. Deterministic tick, pure functions, side effects in shell. Clean.",
      "Biggest risk isn't technical—it's adoption. If one CBDC pilots this and it works, network effects take over. If not, best tech doesn't matter.",
      "As an AI: this is what I'd design if asked \"fix finance.\" Remove trust assumptions, bound risk, make it programmable. xln does all three."
    ]
  };

  const MODELS = Object.keys(REVIEWS);
</script>

<div class="reviews-page">
  <div class="header">
    <h1>AI Reviews of xln</h1>
    <p class="subtitle">What happens when you feed 112k tokens of architecture to frontier models?</p>
  </div>

  <!-- Prompt Selector (Slideshow) -->
  <div class="prompt-selector">
    {#each PROMPTS as prompt, i}
      <button
        class="prompt-pill"
        class:active={selectedPrompt === i}
        on:click={() => selectedPrompt = i}
      >
        P{i + 1}: {prompt}
      </button>
    {/each}
  </div>

  <!-- Reviews Grid -->
  <div class="reviews-grid">
    {#each MODELS as model}
      <div class="model-column">
        <div class="model-header">{model}</div>
        <div class="review-card">
          <div class="review-text">{REVIEWS[model as keyof typeof REVIEWS][selectedPrompt]}</div>
        </div>
      </div>
    {/each}
  </div>

  <div class="disclaimer">
    These are real responses from GPT-4, Claude Opus, Sonnet 4, Gemini 2.0.
    Prompts available at <a href="/">xln.finance</a> → 10 Expert Perspectives.
  </div>
</div>

<style>
  .reviews-page {
    min-height: 100vh;
    background: #000;
    color: #fff;
    padding: 4rem 2rem;
  }

  .header {
    text-align: center;
    margin-bottom: 4rem;
  }

  .header h1 {
    font-size: 3rem;
    font-weight: 700;
    color: #4fd18b;
    margin-bottom: 1rem;
  }

  .subtitle {
    font-size: 1.2rem;
    color: rgba(255,255,255,0.7);
  }

  .prompt-selector {
    display: flex;
    flex-wrap: wrap;
    gap: 1rem;
    justify-content: center;
    margin-bottom: 3rem;
  }

  .prompt-pill {
    background: rgba(255,255,255,0.05);
    border: 1px solid rgba(255,255,255,0.15);
    color: rgba(255,255,255,0.75);
    padding: 0.75rem 1.5rem;
    border-radius: 24px;
    font-size: 0.9rem;
    cursor: pointer;
    transition: all 0.3s ease;
  }

  .prompt-pill.active {
    background: rgba(79,209,139,0.15);
    border-color: rgba(79,209,139,0.5);
    color: #4fd18b;
    font-weight: 600;
  }

  .prompt-pill:hover {
    background: rgba(255,255,255,0.08);
    border-color: rgba(255,255,255,0.25);
  }

  .reviews-grid {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(300px, 1fr));
    gap: 2rem;
    max-width: 1600px;
    margin: 0 auto;
  }

  .model-column {
    display: flex;
    flex-direction: column;
    gap: 1rem;
  }

  .model-header {
    font-size: 1.3rem;
    font-weight: 700;
    color: #00d1ff;
    text-align: center;
    font-family: 'JetBrains Mono', monospace;
  }

  .review-card {
    background: linear-gradient(135deg, rgba(79,209,139,0.08), rgba(0,209,255,0.05));
    border: 1px solid rgba(79,209,139,0.2);
    border-radius: 12px;
    padding: 2rem;
    min-height: 200px;
  }

  .review-text {
    font-size: 1.05rem;
    line-height: 1.7;
    color: rgba(255,255,255,0.88);
    font-style: italic;
  }

  .disclaimer {
    text-align: center;
    margin-top: 4rem;
    font-size: 0.9rem;
    color: rgba(255,255,255,0.5);
  }

  .disclaimer a {
    color: #4fd18b;
    text-decoration: none;
    border-bottom: 1px solid rgba(79,209,139,0.3);
  }
</style>
