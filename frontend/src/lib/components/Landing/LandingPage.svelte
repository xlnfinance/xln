<script lang="ts">
  import './landing-page.css';

  export let onUnlock: () => void;

  const integrationSource = 'https://github.com/xlnfinance/xln/blob/main/docs/agent-payments.md';
  const example = `import { Mppx } from 'mppx/client';
import { xlnMppClient } from './core/api/payments/mpp-client';

const client = Mppx.create({
  methods: [xlnMppClient(payerOptions)],
  polyfill: false,
});

const response = await client.fetch(invoiceUrl);`;
</script>

<div class="agent-landing" lang="en">
  <div class="landing-shell">
    <section class="agent-hero" aria-labelledby="agent-title">
      <div class="hero-copy">
        <p class="eyebrow"><span class="status-dot"></span> The payment substrate for AI agents</p>
        <h1 id="agent-title">Intelligence moves fast.<br /><span>Money should follow.</span></h1>
        <p class="hero-description">
        Pay for an API. Trade an asset. Settle with another agent.
        XLN connects them through bilateral accounts with signed state,
        without a blockchain transaction for every payment.
        </p>
        <div class="landing-actions">
          <button type="button" class="landing-button primary" on:click={onUnlock}>Try the test wallet <span aria-hidden="true">↗</span></button>
          <a class="landing-button secondary" href="#integrate">Build with XLN <span aria-hidden="true">↓</span></a>
        </div>
        <p class="hero-note">Open source · Ethereum first · Experimental agent integrations</p>
      </div>
      <div class="payment-preview" aria-label="Illustrative agent payment flow">
        <div class="preview-header">
          <span>AGENT ↔ SERVICE</span><span class="example-label">Illustrative flow</span>
        </div>
        <div class="preview-route">
          <span class="endpoint-icon" aria-hidden="true">⌘</span><span class="route-line"></span><span class="xln-node">xln</span><span class="route-line"></span><span class="endpoint-icon" aria-hidden="true">↗</span>
        </div>
        <ol class="payment-steps">
          <li>
            <span class="step-number">01</span>
            <div>
              <strong>Request a resource</strong><p>The service returns its price.</p>
            </div>
            <span class="protocol-code">402</span>
          </li>
          <li>
            <span class="step-number">02</span>
            <div>
              <strong>Authorize the payment</strong><p>Check the recipient, asset and debit limit.</p>
            </div>
            <span class="protocol-code">SIGN</span>
          </li>
          <li>
            <span class="step-number">03</span>
            <div>
              <strong>Verify. Deliver.</strong><p>The service checks its own payment record.</p>
            </div>
            <span class="protocol-code receipt-code">200</span>
          </li>
        </ol>
        <div class="preview-footer">
          <span class="status-dot"></span> One order. One saved payment intent.
        </div>
      </div>
    </section>
    <section class="account-section" aria-labelledby="account-title">
      <div class="section-heading">
        <p class="eyebrow">A relationship, beyond a transaction</p><h2 id="account-title">One account. More ways to move value.</h2>
      </div>
      <div class="capability-grid">
        <article>
          <span class="capability-number">01 / PAY</span><h3>Pay as work happens.</h3><p>Exchange signed updates with counterparties. Buy data, tools and services through repeatable payment flows.</p><span class="capability-detail">Bilateral payments</span>
        </article>
        <article>
          <span class="capability-number">02 / SWAP</span><h3>Trade what you have.</h3><p>Exchange assets through the same Account model. A payment and a swap still need explicit execution terms.</p><span class="capability-detail">Account-based swaps</span>
        </article>
        <article>
          <span class="capability-number">03 / RESOLVE</span><h3>Keep a path to exit.</h3><p>Use signed state in an on-chain dispute. Collateral secures recovery; unsecured credit remains counterparty risk.</p><span class="capability-detail">Enforceable signed state</span>
        </article>
      </div>
    </section>
    <section class="integration-section" id="integrate" aria-labelledby="integrate-title">
      <div class="integration-copy">
        <p class="eyebrow">Meet agents where they already work</p>
        <h2 id="integrate-title">Your API.<br />An XLN payment method.</h2>
        <p>Keep the HTTP request. Add a payment method to an existing SDK. XLN handles the bilateral payment underneath.</p>
        <div class="integration-status">
          <span>MPP / mppx</span><span class="status-tag">Experimental adapter</span>
        </div>
        <p class="integration-note">The <code>xln/charge</code> method lives in the repository. Both payer and service must enable it.</p>
        <a class="text-link" href={integrationSource} target="_blank" rel="noopener noreferrer">Read the integration guide <span aria-hidden="true">↗</span></a>
      </div>
      <div class="code-panel">
        <div class="code-header">
          <span>MPP CLIENT</span><span>TypeScript · repository example</span>
        </div>
        <pre><code>{example}</code></pre><p><code>payerOptions</code> connects a trusted runtime, merchant and asset pins, a debit limit, and durable intent storage. See the guide for setup.</p>
      </div>
    </section>
    <section class="control-section" aria-labelledby="control-title">
      <div class="section-heading">
        <p class="eyebrow">Autonomy with explicit authority</p><h2 id="control-title">Give the agent a task.<br />Keep control of the money.</h2>
      </div>
      <div class="control-grid">
        <div>
          <span class="control-symbol" aria-hidden="true">↗</span><h3>Authorize the destination.</h3><p>Pin the merchant, asset and maximum debit in a trusted runner. Keep signing keys outside the model context.</p>
        </div>
        <div>
          <span class="control-symbol" aria-hidden="true">↻</span><h3>Resume the same intent.</h3><p>Save the payment before sending. Reuse it after a lost response instead of creating another payment.</p>
        </div>
        <div>
          <span class="control-symbol" aria-hidden="true">≡</span><h3>Verify what happened.</h3><p>The merchant checks its own committed receipt. A submitted command alone is not proof of payment.</p>
        </div>
      </div>
      <p class="scope-note">A per-payment debit limit is not a delegated spending budget. The host remains responsible for authorization.</p>
    </section>
    <section class="landing-faq" aria-labelledby="faq-title">
      <div>
        <p class="eyebrow">Before you build</p><h2 id="faq-title">Clear terms.<br />Fewer surprises.</h2>
      </div>
      <div class="faq-items">
        <details>
          <summary>What can I try today?</summary><p>The test wallet and experimental MPP adapter. Agent integration work starts with Ethereum accounts in one jurisdiction. Mainnet readiness is a separate release gate.</p>
        </details>
        <details>
          <summary>Does this work with any MPP or x402 service?</summary><p>A service must accept XLN explicitly. The MPP adapter is experimental; x402 and MCP connections are in development. XLN does not automatically pay services that only accept other payment methods.</p>
        </details>
        <details>
          <summary>Does a dispute guarantee a refund?</summary><p>A state dispute enforces the signed Account state. It does not judge the quality of an API response. Only collateral secures recovery; unsecured claims depend on the counterparty's solvency.</p>
        </details>
      </div>
    </section>
    <section class="closing-section">
      <p class="eyebrow">Build the economy between agents</p><h2>Let software move value.</h2>
      <div class="landing-actions">
        <button type="button" class="landing-button primary" on:click={onUnlock}>Open the test wallet <span aria-hidden="true">↗</span></button><a class="landing-button secondary" href={integrationSource} target="_blank" rel="noopener noreferrer">Explore the integration <span aria-hidden="true">↗</span></a>
      </div>
    </section>
    <footer class="landing-footer">
      <a class="footer-wordmark" href="/" aria-label="XLN home">xln<span>Cross-Local Network</span></a>
      <nav aria-label="Project links">
        <a href="/docs">Documentation</a><a href="https://github.com/xlnfinance/xln" target="_blank" rel="noopener noreferrer">GitHub</a><a href="https://x.com/xlnfinance" target="_blank" rel="noopener noreferrer">Updates</a>
      </nav>
    </footer>
  </div>
</div>
