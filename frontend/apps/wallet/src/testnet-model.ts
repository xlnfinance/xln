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
    description: 'React wallet candidate for identity rehearsal, connected Runtime balances, payments, and orderbook trading.',
    href: '/app',
    icon: '💳',
    badges: ['Desktop', 'Mobile'],
    cta: 'Open Wallet',
    note: 'Connect a remote Runtime for live financial controls',
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
