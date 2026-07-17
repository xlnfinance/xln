import { parsePositiveAssetAmount } from './entity-asset-values';
import { getMoveRouteKey, type MoveEndpoint } from './move-routes';

export type MoveAllowanceToken = {
  decimals: number;
} | null;

export function buildMoveAllowanceContextSignature(input: {
  enabled: boolean;
  from: MoveEndpoint;
  to: MoveEndpoint;
  assetSymbol: string;
  signerId: string | null | undefined;
  runtimeId: string | null | undefined;
}): string {
  return [
    input.enabled ? '1' : '0',
    getMoveRouteKey(input.from, input.to),
    input.assetSymbol,
    String(input.signerId || '').trim().toLowerCase(),
    String(input.runtimeId || ''),
  ].join('|');
}

export function getMoveRequiredAllowanceAmount(input: {
  enabled: boolean;
  token: MoveAllowanceToken;
  amountInput: string;
  sourceAvailableBalance: bigint | null | undefined;
}): bigint | null {
  if (!input.enabled || !input.token) return null;
  try {
    return parsePositiveAssetAmount(input.amountInput, input.token, input.sourceAvailableBalance ?? undefined);
  } catch {
    return null;
  }
}

export function isMoveAllowanceSatisfied(required: bigint | null, raw: bigint | null): boolean {
  return typeof required === 'bigint' && typeof raw === 'bigint' && raw >= required;
}

export function buildMoveAllowanceStatusLabel(input: {
  enabled: boolean;
  tokenSymbol: string;
  tokenDecimals: number | null;
  metadataLoading: boolean;
  raw: bigint | null;
  loading: boolean;
  error: string | null;
  required: bigint | null;
  formatAmount: (amount: bigint, decimals: number) => string;
}): string {
  if (!input.enabled) return '';
  if (input.metadataLoading) return 'Loading asset metadata...';
  if (input.tokenDecimals === null) {
    throw new Error(`MOVE_ALLOWANCE_TOKEN_METADATA_MISSING:${input.tokenSymbol}`);
  }
  const available = typeof input.raw === 'bigint'
    ? input.formatAmount(input.raw, input.tokenDecimals)
    : '—';
  if (input.loading) return 'Checking allowance...';
  if (input.error) return input.error;
  if (typeof input.required !== 'bigint') {
    return `Current allowance ${available} ${input.tokenSymbol}`;
  }
  const required = input.formatAmount(input.required, input.tokenDecimals);
  return `Current allowance ${available} ${input.tokenSymbol} · required ${required} ${input.tokenSymbol}`;
}
