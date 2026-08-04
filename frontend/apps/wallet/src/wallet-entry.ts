import type { WalletEnvironment } from '../../../packages/runtime-client/wallet-boot-machine';

export type WalletScenarioPreview = Readonly<{
  scenarioId: string;
  frame: number;
}>;

export const parseWalletScenarioPreview = (search: string): WalletScenarioPreview | null => {
  const params = new URLSearchParams(search);
  if (params.get('scenarioPreview') !== '1') return null;
  if (params.get('locktest') !== '1') throw new Error('REACT_WALLET_SCENARIO_PREVIEW_LOCK_REQUIRED');
  const scenarioId = String(params.get('scenario') || '').trim();
  if (!/^[a-z0-9-]+$/.test(scenarioId)) throw new Error('REACT_WALLET_SCENARIO_PREVIEW_ID_INVALID');
  const frame = Number(params.get('frame'));
  if (!Number.isSafeInteger(frame) || frame < 0) throw new Error('REACT_WALLET_SCENARIO_PREVIEW_FRAME_INVALID');
  return Object.freeze({ scenarioId, frame });
};

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
