import type { RoutedEntityInput } from '../types';
import { buildRouteOutputKey, splitRoutedOutputByDeliveryLane } from './identity';

type PreparedRoutedOutput = Readonly<{
  output: RoutedEntityInput;
  routeKey: string;
}>;

/**
 * One Runtime-frame-local derivation graph for immutable routed outputs: route
 * keys and payload splits are computed once per exact output object. Merge
 * targets are the sole mutable envelopes; callers invalidate one immediately
 * after a merge. Ephemeral execution data, never persisted.
 */
export type PreparedOutputGraph = Readonly<{
  prepare(output: RoutedEntityInput): PreparedRoutedOutput;
  adopt(source: RoutedEntityInput, exactCopy: RoutedEntityInput): void;
  split(output: RoutedEntityInput): readonly RoutedEntityInput[];
  invalidate(output: RoutedEntityInput): void;
}>;

export const createPreparedOutputGraph = (): PreparedOutputGraph => {
  const prepared = new Map<RoutedEntityInput, PreparedRoutedOutput>();
  const splitLanes = new Map<RoutedEntityInput, readonly RoutedEntityInput[]>();
  return Object.freeze({
    prepare(output: RoutedEntityInput): PreparedRoutedOutput {
      const existing = prepared.get(output);
      if (existing) return existing;
      const value = Object.freeze({ output, routeKey: buildRouteOutputKey(output) });
      prepared.set(output, value);
      return value;
    },
    split(output: RoutedEntityInput): readonly RoutedEntityInput[] {
      const existing = splitLanes.get(output);
      if (existing) return existing;
      const lanes = Object.freeze(splitRoutedOutputByDeliveryLane(output));
      splitLanes.set(output, lanes);
      for (const lane of lanes) splitLanes.set(lane, Object.freeze([lane]));
      return lanes;
    },
    adopt(source: RoutedEntityInput, exactCopy: RoutedEntityInput): void {
      const sourcePrepared = prepared.get(source);
      if (sourcePrepared) prepared.set(exactCopy, Object.freeze({ ...sourcePrepared, output: exactCopy }));
      splitLanes.set(exactCopy, Object.freeze([exactCopy]));
    },
    invalidate(output: RoutedEntityInput): void {
      prepared.delete(output);
    },
  });
};
