export type WalletPage =
  | Readonly<{ kind: 'testnet' }>
  | Readonly<{ kind: 'pending'; pathname: string }>;

export const resolveWalletPage = (pathname: string): WalletPage => pathname === '/testnet'
  ? { kind: 'testnet' }
  : { kind: 'pending', pathname };
