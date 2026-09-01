// Framework-neutral view model for the workspace Solvency panel. The Runtime
// owns financial computation; this module only projects its typed result into
// deterministic display order and presentation labels shared by Svelte and
// the future React workspace.

import type { RuntimeAdapterSolvencySummary } from '@xln/core/api/public/runtime-module';

export type SolvencyAsset = RuntimeAdapterSolvencySummary['assets'][number];
export type SolvencyProjection = Pick<RuntimeAdapterSolvencySummary, 'assets' | 'isValid'>;

export type SolvencyCalculation = Readonly<{
  byAsset: ReadonlyMap<string, SolvencyAsset>;
  isValid: boolean | null;
}>;

export type SolvencyStatusView = Readonly<{
  icon: '✓' | '⚠' | '?';
  label: 'ASSET CONSERVATION OK' | 'ASSET IMBALANCE DETECTED' | 'ASSET CONSERVATION NOT VERIFIED';
  tone: 'valid' | 'invalid' | 'unchecked';
}>;

export const buildSolvencyProjection = (
  solvency: SolvencyCalculation,
): SolvencyProjection => ({
  assets: Array.from(solvency.byAsset.values())
    .sort((left, right) => left.stackId.localeCompare(right.stackId) || left.tokenId - right.tokenId),
  isValid: solvency.isValid,
});

export const getSolvencyStatusView = (isValid: boolean | null): SolvencyStatusView =>
  isValid === true
    ? { icon: '✓', label: 'ASSET CONSERVATION OK', tone: 'valid' }
    : isValid === false
      ? { icon: '⚠', label: 'ASSET IMBALANCE DETECTED', tone: 'invalid' }
      : { icon: '?', label: 'ASSET CONSERVATION NOT VERIFIED', tone: 'unchecked' };

export const formatSolvencyAmount = (amount: bigint): string => amount.toLocaleString('en-US');

export const shortenSolvencyAddress = (address: string): string =>
  `${address.slice(0, 8)}…${address.slice(-6)}`;
