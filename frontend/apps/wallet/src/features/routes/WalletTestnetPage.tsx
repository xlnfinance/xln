const cards = [
  { title: 'Web wallet', description: 'Create a protected local runtime, connect to hubs, submit payments, and trade on the orderbook.', href: '/app', label: 'Open wallet', note: 'Desktop and mobile', external: false },
  { title: 'Custody demo', description: 'Exercise deposits and withdrawals from the service integration side against the same test network.', href: 'https://custody.xln.finance', label: 'Try custody', note: 'External integration', external: true },
  { title: 'Network status', description: 'Inspect hub health, chain synchronization, connected peers, and Runtime diagnostics.', href: '/health', label: 'View status', note: 'Live operator data', external: false },
] as const;

export const WalletTestnetPage = () => (
  <main className="wallet-testnet" data-testid="wallet-testnet-page">
    <header><a className="wallet-wordmark" href="/">xln<span>/testnet</span></a><p>TESTNET · NO REAL FUNDS</p><h1>Bilateral payments,<br />observable end to end.</h1><span>Use the release-blocked React wallet candidate against the local xln test network.</span></header>
    <section>{cards.map((card, index) => <a href={card.href} key={card.title} target={card.external ? '_blank' : undefined} rel={card.external ? 'noopener noreferrer' : undefined}><em>0{index + 1}</em><h2>{card.title}</h2><p>{card.description}</p><small>{card.note}</small><strong>{card.label} →</strong></a>)}</section>
    <footer><span>Deterministic Runtime → Entity → Account transitions</span><nav><a href="https://github.com/xln-finance" target="_blank" rel="noreferrer">GitHub</a><a href="https://x.com/xlnfinance" target="_blank" rel="noreferrer">X</a><a href="/docs">Docs</a></nav></footer>
  </main>
);
