<script lang="ts">
  const cards = [
    {
      title: 'Web Wallet',
      description: 'Full wallet experience in your browser. Create a wallet, connect to hubs, send payments, and trade on the orderbook.',
      href: '/app',
      icon: '💳',
      badges: ['Desktop', 'Mobile'],
      cta: 'Open Wallet',
      note: 'Extension & native apps coming soon',
    },
    {
      title: 'Custody Demo',
      description: 'See how merchants integrate xln payments. Deposit, withdraw, and experience the custody API from a service perspective.',
      href: 'https://custody.xln.finance',
      icon: '🏪',
      badges: ['Integration'],
      cta: 'Try Custody',
      note: 'Uses the same testnet as the wallet',
      external: true,
    },
    {
      title: 'Network Status',
      description: 'Monitor hub health, chain sync status, connected peers, and runtime diagnostics in real-time.',
      href: '/health',
      icon: '📡',
      badges: ['Live'],
      cta: 'View Status',
    },
  ];
</script>

<div class="testnet-page">
  <header class="hero">
    <div class="hero-badge">TESTNET</div>
    <h1>xln Testnet</h1>
    <p class="hero-sub">Explore the bilateral payment network. Free to use, no real funds at risk.</p>
  </header>

  <div class="cards">
    {#each cards as card}
      <a
        class="card"
        href={card.href}
        target={card.external ? '_blank' : undefined}
        rel={card.external ? 'noopener noreferrer' : undefined}
      >
        <div class="card-icon">{card.icon}</div>
        <h2>{card.title}</h2>
        <p class="card-desc">{card.description}</p>
        <div class="card-badges">
          {#each card.badges as badge}
            <span class="badge">{badge}</span>
          {/each}
        </div>
        <div class="card-cta">{card.cta} →</div>
        {#if card.note}
          <p class="card-note">{card.note}</p>
        {/if}
      </a>
    {/each}
  </div>

  <footer class="footer">
    <p>Built with bilateral consensus. Every payment is a cryptographic proof.</p>
    <div class="footer-links">
      <a href="https://github.com/xln-finance" target="_blank" rel="noopener">GitHub</a>
      <a href="https://x.com/xlnfinance" target="_blank" rel="noopener">Twitter</a>
      <a href="/docs">Docs</a>
    </div>
  </footer>
</div>

<style>
  .testnet-page {
    min-height: 100dvh;
    background: #09090b;
    color: #e4e4e7;
    padding: 48px 24px;
    display: flex;
    flex-direction: column;
    align-items: center;
  }

  .hero {
    text-align: center;
    max-width: 600px;
    margin-bottom: 48px;
  }

  .hero-badge {
    display: inline-block;
    padding: 4px 12px;
    border-radius: 999px;
    background: rgba(251, 191, 36, 0.1);
    border: 1px solid rgba(251, 191, 36, 0.25);
    color: #fbbf24;
    font-size: 11px;
    font-weight: 700;
    letter-spacing: 0.12em;
    margin-bottom: 16px;
  }

  h1 {
    font-size: clamp(32px, 6vw, 48px);
    font-weight: 700;
    letter-spacing: -0.03em;
    margin: 0 0 12px;
  }

  .hero-sub {
    color: #71717a;
    font-size: 15px;
    line-height: 1.5;
    margin: 0;
  }

  .cards {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(280px, 1fr));
    gap: 20px;
    max-width: 960px;
    width: 100%;
  }

  .card {
    background: #18181b;
    border: 1px solid #27272a;
    border-radius: 16px;
    padding: 28px 24px;
    text-decoration: none;
    color: inherit;
    transition: all 0.2s ease;
    display: flex;
    flex-direction: column;
  }

  .card:hover {
    border-color: #fbbf24;
    background: #1c1c20;
    transform: translateY(-2px);
    box-shadow: 0 8px 32px rgba(251, 191, 36, 0.08);
  }

  .card-icon {
    font-size: 32px;
    margin-bottom: 12px;
  }

  .card h2 {
    font-size: 20px;
    font-weight: 700;
    margin: 0 0 8px;
  }

  .card-desc {
    color: #a1a1aa;
    font-size: 13px;
    line-height: 1.5;
    margin: 0 0 16px;
    flex: 1;
  }

  .card-badges {
    display: flex;
    gap: 6px;
    margin-bottom: 16px;
  }

  .badge {
    padding: 3px 8px;
    border-radius: 6px;
    background: rgba(74, 222, 128, 0.08);
    border: 1px solid rgba(74, 222, 128, 0.15);
    color: #4ade80;
    font-size: 10px;
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.05em;
  }

  .card-cta {
    color: #fbbf24;
    font-size: 14px;
    font-weight: 700;
  }

  .card-note {
    color: #52525b;
    font-size: 11px;
    margin: 8px 0 0;
    font-style: italic;
  }

  .footer {
    margin-top: 64px;
    text-align: center;
    color: #52525b;
    font-size: 13px;
  }

  .footer p {
    margin: 0 0 12px;
  }

  .footer-links {
    display: flex;
    gap: 16px;
    justify-content: center;
  }

  .footer-links a {
    color: #71717a;
    text-decoration: none;
    font-size: 12px;
  }

  .footer-links a:hover {
    color: #fbbf24;
  }

  @media (max-width: 640px) {
    .testnet-page {
      padding: 32px 16px;
    }
    .cards {
      grid-template-columns: 1fr;
    }
  }
</style>
