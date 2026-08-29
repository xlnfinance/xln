export type WalletPage =
  | Readonly<{ kind: 'testnet' }>
  | Readonly<{ kind: 'app' }>
  | Readonly<{ kind: 'pending'; pathname: string }>;

export const resolveWalletPage = (pathname: string): WalletPage => {
  if (pathname === '/testnet') return { kind: 'testnet' };
  if (pathname === '/app') return { kind: 'app' };
  return { kind: 'pending', pathname };
};

export const walletPageMetadata = (page: WalletPage): Readonly<{
  title: string;
  description: string;
}> => page.kind === 'testnet'
  ? {
    title: 'xln Testnet',
    description: 'Explore the xln bilateral payment network on testnet.',
  }
  : page.kind === 'app'
    ? {
      title: 'xln Wallet',
      description: 'Inspect your xln Runtime and wallet authority.',
    }
    : {
      title: 'xln Wallet',
      description: 'The independently built xln wallet candidate.',
    };
