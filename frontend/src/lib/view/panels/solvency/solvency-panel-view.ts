import { calculateSolvency } from '@xln/core/api/public/public-utilities';
import type { RuntimeReplica } from '@xln/core/api/public/runtime-module';
import {
  buildSolvencyProjection as projectSolvencyCalculation,
  type SolvencyProjection,
} from '../../../../../packages/runtime-client/src/solvency-panel-view';

export type { SolvencyProjection };

export type SolvencyFrame = RuntimeReplica;

export function buildSolvencyProjection(
  frame: SolvencyFrame | null | undefined,
): SolvencyProjection | null {
  if (!(frame?.state.eReplicas instanceof Map)) return null;
  return projectSolvencyCalculation(calculateSolvency(frame));
}
