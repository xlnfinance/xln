<script lang="ts">
  // Placeholder for documentation view
</script>

<div class="docs-container">
  <h1>Documentation</h1>

  <div class="docs-content">
    <div class="doc-section">
      <h2>Getting Started</h2>
      <p>XLN (Cross-Local Network) is a cross-jurisdictional off-chain settlement network enabling distributed entities to exchange messages and value instantly off-chain while anchoring final outcomes on-chain.</p>
    </div>

    <div class="doc-section">
      <h2>Architecture</h2>
      <p>The system follows a layered architecture with pure functional state machines:</p>
      <ul>
        <li><strong>Entity Layer:</strong> BFT consensus state machine handling ADD_TX → PROPOSE → SIGN → COMMIT flow</li>
        <li><strong>Server Layer:</strong> Routes inputs every 100ms tick, maintains global state via ServerFrames</li>
        <li><strong>Runtime Layer:</strong> Side-effectful shell managing cryptography and I/O</li>
      </ul>
    </div>

    <div class="doc-section">
      <h2>Key Concepts</h2>
      <h3>Reserve-Credit Provable Account Network (RCPAN)</h3>
      <p>XLN is the first RCPAN combining credit where it scales with collateral where it secures:</p>
      <div class="invariant-box">
        <p><strong>FCUAN:</strong> −leftCredit ≤ Δ ≤ rightCredit</p>
        <p><strong>FRPAP:</strong> 0 ≤ Δ ≤ collateral</p>
        <p><strong>RCPAN:</strong> −leftCredit ≤ Δ ≤ collateral + rightCredit</p>
      </div>
    </div>

    <div class="doc-section">
      <h2>Development Commands</h2>
      <pre><code># Install dependencies
bun install

# Run the demo
bun run index.ts

# Run tests
bun test

# Build for production
bun run build</code></pre>
    </div>

    <div class="doc-section">
      <h2>Resources</h2>
      <ul>
        <li><a href="https://github.com/anthropics/claude-code" target="_blank">GitHub Repository</a></li>
        <li><a href="/docs/README.md" target="_blank">Full Documentation</a></li>
        <li><a href="/docs/JEA.md" target="_blank">Jurisdiction-Entity-Account Model</a></li>
        <li><a href="/docs/payment-spec.md" target="_blank">Payment Specifications</a></li>
      </ul>
    </div>
  </div>
</div>

<style>
  .docs-container {
    max-width: 900px;
    margin: 60px auto;
    padding: 40px;
    background: rgba(30, 30, 30, 0.8);
    backdrop-filter: blur(10px);
    border-radius: 12px;
    border: 1px solid rgba(255, 255, 255, 0.1);
  }

  h1 {
    font-size: 32px;
    font-weight: 700;
    color: #00d9ff;
    margin: 0 0 40px 0;
    text-align: center;
  }

  h2 {
    font-size: 24px;
    color: #ffffff;
    margin: 32px 0 16px 0;
    font-weight: 600;
  }

  h3 {
    font-size: 18px;
    color: #00d9ff;
    margin: 20px 0 12px 0;
    font-weight: 600;
  }

  .docs-content {
    display: flex;
    flex-direction: column;
    gap: 24px;
  }

  .doc-section {
    background: rgba(20, 20, 20, 0.6);
    padding: 24px;
    border-radius: 8px;
    border: 1px solid rgba(255, 255, 255, 0.05);
  }

  p {
    font-size: 16px;
    line-height: 1.8;
    color: rgba(255, 255, 255, 0.85);
    margin: 0 0 16px 0;
  }

  ul {
    list-style: none;
    padding: 0;
    margin: 16px 0;
  }

  li {
    font-size: 16px;
    line-height: 1.8;
    color: rgba(255, 255, 255, 0.85);
    margin: 8px 0;
    padding-left: 24px;
    position: relative;
  }

  li:before {
    content: '▸';
    position: absolute;
    left: 0;
    color: #00ff88;
  }

  .invariant-box {
    background: rgba(0, 122, 204, 0.1);
    border-left: 3px solid #007acc;
    padding: 16px 20px;
    margin: 24px 0;
    font-family: 'Courier New', monospace;
    font-size: 14px;
    line-height: 1.8;
  }

  .invariant-box p {
    margin: 8px 0;
    color: #00d9ff;
  }

  pre {
    background: rgba(0, 0, 0, 0.4);
    padding: 16px;
    border-radius: 6px;
    overflow-x: auto;
  }

  code {
    font-family: 'Courier New', monospace;
    font-size: 14px;
    color: #00ff88;
  }

  a {
    color: #00d9ff;
    text-decoration: none;
    transition: color 0.2s ease;
  }

  a:hover {
    color: #00ff88;
    text-decoration: underline;
  }
</style>
