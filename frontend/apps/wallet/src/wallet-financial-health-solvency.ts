import type { WalletPortfolioMath } from './wallet-portfolio-model';
import {
  requireRuntimeBigInt,
  requireRuntimeInteger,
  requireRuntimeRecord,
  requireRuntimeString,
} from './wallet-runtime-decode';

export type WalletSolvencyStatus = 'unchecked' | 'balanced' | 'mismatch';

export type WalletSolvencyAsset = Readonly<{
  key: string;
  stackLabel: string;
  tokenId: number;
  symbol: string;
  reservesLabel: string;
  collateralLabel: string;
  internalValueLabel: string;
  expectedValueLabel: string;
  deltaLabel: string;
  status: WalletSolvencyStatus;
}>;

const triState = (value: unknown, label: string): boolean | null => {
  if (value === null || typeof value === 'boolean') return value;
  throw new Error(`${label}_INVALID`);
};

const statusFromTriState = (value: boolean | null): WalletSolvencyStatus =>
  value === null ? 'unchecked' : value ? 'balanced' : 'mismatch';

export const readWalletSolvencyHeight = (value: unknown): number =>
  requireRuntimeInteger(
    requireRuntimeRecord(value, 'WALLET_HEALTH_SOLVENCY')['height'],
    'WALLET_HEALTH_SOLVENCY_HEIGHT',
  );

export const decodeWalletSolvency = (value: unknown, math: WalletPortfolioMath) => {
  const root = requireRuntimeRecord(value, 'WALLET_HEALTH_SOLVENCY');
  if (root['ok'] !== true) throw new Error('WALLET_HEALTH_SOLVENCY_NOT_OK');
  const overall = triState(root['isValid'], 'WALLET_HEALTH_SOLVENCY_STATUS');
  if (!Array.isArray(root['assets'])) throw new Error('WALLET_HEALTH_SOLVENCY_ASSETS_INVALID');
  const assets = root['assets'].map((value): WalletSolvencyAsset => {
    const asset = requireRuntimeRecord(value, 'WALLET_HEALTH_SOLVENCY_ASSET');
    const stackId = requireRuntimeString(asset['stackId'], 'WALLET_HEALTH_SOLVENCY_STACK');
    const chainId = requireRuntimeInteger(asset['chainId'], 'WALLET_HEALTH_SOLVENCY_CHAIN', 1);
    const depository = requireRuntimeString(asset['depositoryAddress'], 'WALLET_HEALTH_SOLVENCY_DEPOSITORY').toLowerCase();
    if (stackId !== `${chainId}:${depository}` || !/^0x[0-9a-f]{40}$/.test(depository)) {
      throw new Error('WALLET_HEALTH_SOLVENCY_STACK_MISMATCH');
    }
    const tokenId = requireRuntimeInteger(asset['tokenId'], 'WALLET_HEALTH_SOLVENCY_TOKEN', 1);
    const reserves = requireRuntimeBigInt(asset['reserves'], 'WALLET_HEALTH_SOLVENCY_RESERVES');
    const collateral = requireRuntimeBigInt(asset['confirmedCollateral'], 'WALLET_HEALTH_SOLVENCY_COLLATERAL');
    const internalValue = requireRuntimeBigInt(asset['internalValue'], 'WALLET_HEALTH_SOLVENCY_INTERNAL');
    if (internalValue !== reserves + collateral) throw new Error('WALLET_HEALTH_SOLVENCY_INTERNAL_MISMATCH');
    const expected = asset['expectedInternalValue'] === null
      ? null
      : requireRuntimeBigInt(asset['expectedInternalValue'], 'WALLET_HEALTH_SOLVENCY_EXPECTED');
    const delta = asset['delta'] === null
      ? null
      : requireRuntimeBigInt(asset['delta'], 'WALLET_HEALTH_SOLVENCY_DELTA');
    const valid = triState(asset['isValid'], 'WALLET_HEALTH_SOLVENCY_ASSET_STATUS');
    if ((expected === null) !== (delta === null) || (expected === null) !== (valid === null)) {
      throw new Error('WALLET_HEALTH_SOLVENCY_EVIDENCE_MISMATCH');
    }
    if (expected !== null && (delta !== internalValue - expected || valid !== (delta === 0n))) {
      throw new Error('WALLET_HEALTH_SOLVENCY_RESULT_MISMATCH');
    }
    return {
      key: `${stackId}:${tokenId}`,
      stackLabel: `Chain ${chainId} · ${depository.slice(0, 8)}…${depository.slice(-6)}`,
      tokenId,
      symbol: math.getTokenInfo(tokenId).symbol,
      reservesLabel: math.formatTokenAmount(tokenId, reserves),
      collateralLabel: math.formatTokenAmount(tokenId, collateral),
      internalValueLabel: math.formatTokenAmount(tokenId, internalValue),
      expectedValueLabel: expected === null ? 'Not supplied' : math.formatTokenAmount(tokenId, expected),
      deltaLabel: delta === null ? 'Not checked' : math.formatTokenAmount(tokenId, delta),
      status: statusFromTriState(valid),
    };
  });
  const derivedOverall = assets.some(({ status }) => status === 'mismatch')
    ? false
    : assets.length > 0 && assets.every(({ status }) => status === 'balanced')
      ? true
      : null;
  if (overall !== derivedOverall) throw new Error('WALLET_HEALTH_SOLVENCY_OVERALL_MISMATCH');
  return {
    height: readWalletSolvencyHeight(root),
    status: statusFromTriState(overall),
    entityCount: requireRuntimeInteger(root['entityCount'], 'WALLET_HEALTH_SOLVENCY_ENTITIES'),
    accountViews: requireRuntimeInteger(root['accountViews'], 'WALLET_HEALTH_SOLVENCY_ACCOUNTS'),
    assets,
  };
};
