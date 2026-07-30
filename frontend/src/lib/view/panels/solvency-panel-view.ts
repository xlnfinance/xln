import { calculateSolvency } from '@xln/runtime/api/public-utilities';
import type { RuntimeReplica, RuntimeAdapterSolvencySummary } from '@xln/runtime/api/runtime-module';

export type SolvencyProjection = Pick<RuntimeAdapterSolvencySummary, 'assets' | 'isValid'>;

export type SolvencyFrame = Pick<RuntimeReplica, 'eReplicas'>;

export function buildSolvencyProjection(
  frame: SolvencyFrame | null | undefined,
): SolvencyProjection | null {
  if (!(frame?.eReplicas instanceof Map)) return null;
  const solvency = calculateSolvency(frame as RuntimeReplica);
  return {
    assets: Array.from(solvency.byAsset.values())
      .sort((left, right) => left.stackId.localeCompare(right.stackId) || left.tokenId - right.tokenId),
    isValid: solvency.isValid,
  };
}
