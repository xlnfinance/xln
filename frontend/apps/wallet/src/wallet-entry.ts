import type { WalletEnvironment } from '../../../packages/runtime-client/wallet-boot-machine';

export const normalizeWalletEntryPath = (
  pathname: string,
  environment: WalletEnvironment,
): string => {
  const normalized = pathname === '/' ? '/' : `/${pathname.split('/').filter(Boolean).join('/')}`;
  if (normalized === '/' && environment !== 'browser') return '/app';
  if (
    normalized === '/app'
    || normalized === '/address'
    || normalized.startsWith('/address/')
    || normalized === '/testnet'
  ) return normalized;
  throw new Error(`REACT_WALLET_ROUTE_UNKNOWN:${normalized}`);
};
