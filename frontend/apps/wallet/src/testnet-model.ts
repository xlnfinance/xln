export type TestnetCard = Readonly<{
  title: string;
  description: string;
  href: string;
  icon: string;
  badges: readonly string[];
  cta: string;
  note?: string;
  external?: true;
}>;

export const TESTNET_CARDS: readonly TestnetCard[] = [
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

export const createDemoWalletHref = (label: string): string => {
  const normalized = label.trim();
  if (!normalized) throw new Error('TESTNET_DEMO_LABEL_REQUIRED');
  return `/app?demo=${encodeURIComponent(normalized)}`;
};
