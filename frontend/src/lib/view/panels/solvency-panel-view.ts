import { calculateSolvency } from '@xln/runtime/api/public-utilities';
import type { RuntimeReplica, RuntimeAdapterSolvencySummary } from '@xln/runtime/api/runtime-module';

export type SolvencyProjection = Pick<RuntimeAdapterSolvencySummary, 'assets' | 'isValid'>;

export type SolvencyFrame = RuntimeReplica;

export function buildSolvencyProjection(
  frame: SolvencyFrame | null | undefined,
): SolvencyProjection | null {
  if (!(frame?.state.eReplicas instanceof Map)) return null;
  const solvency = calculateSolvency(frame);
  return {
    assets: Array.from(solvency.byAsset.values())
      .sort((left, right) => left.stackId.localeCompare(right.stackId) || left.tokenId - right.tokenId),
    isValid: solvency.isValid,
  };
}
