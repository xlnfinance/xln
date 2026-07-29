import { calculateSolvency } from '@xln/runtime/api/public-utilities';
import type { RuntimeState, RuntimeAdapterSolvencySummary } from '@xln/runtime/xln-api';

export type SolvencyProjection = Pick<RuntimeAdapterSolvencySummary, 'assets' | 'isValid'>;

export type SolvencyFrame = Pick<RuntimeState, 'eReplicas'>;

export function buildSolvencyProjection(
  frame: SolvencyFrame | null | undefined,
): SolvencyProjection | null {
  if (!(frame?.eReplicas instanceof Map)) return null;
  const solvency = calculateSolvency(frame as RuntimeState);
  return {
    assets: Array.from(solvency.byAsset.values())
      .sort((left, right) => left.stackId.localeCompare(right.stackId) || left.tokenId - right.tokenId),
    isValid: solvency.isValid,
  };
}
