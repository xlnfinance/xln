import type { RoutedEntityInput } from '../types';
import {
  buildRouteOutputKeyWithIdentity,
  getReliableOutputIdentity,
  splitRoutedOutputByDeliveryLane,
  type ReliableOutputIdentity,
} from './identity';

export type PreparedRoutedOutput = Readonly<{
  output: RoutedEntityInput;
  reliableIdentity: ReliableOutputIdentity | null;
  routeKey: string;
}>;

export type PreparedOutputDerivationMetrics = Readonly<{
  outputs: number;
  reliableIdentities: number;
  routeKeys: number;
  laneSplits: number;
}>;

/**
 * One Runtime-frame-local derivation graph for immutable routed outputs.
 *
 * Reliable identities hash canonical consensus evidence and are expensive.
 * Keep their result beside the exact output object while the frame moves from
 * pending normalization through routing and dispatch. Merge targets are the
 * sole mutable envelopes; callers must invalidate one immediately after a
 * merge so no stale identity can cross an authority decision.
 * This graph is ephemeral execution data: it is never attached to a Runtime,
 * Entity, Account, WAL frame, snapshot, retry record, or recovery bundle.
 * Replay reconstructs it from the committed routed outputs.
 */
export type PreparedOutputGraph = Readonly<{
  prepare(output: RoutedEntityInput): PreparedRoutedOutput;
  adopt(source: RoutedEntityInput, exactCopy: RoutedEntityInput): void;
  split(output: RoutedEntityInput): readonly RoutedEntityInput[];
  invalidate(output: RoutedEntityInput): void;
  metrics(): PreparedOutputDerivationMetrics;
}>;

export const createPreparedOutputGraph = (): PreparedOutputGraph => {
  // Frame-bounded graph with explicit cleanup by object lifetime. Hidden
  // GC-controlled storage is forbidden because it cannot be inspected.
  const prepared = new Map<RoutedEntityInput, PreparedRoutedOutput>();
  let outputs = 0;
  let reliableIdentities = 0;
  let routeKeys = 0;
  let laneSplits = 0;
  const splitLanes = new Map<RoutedEntityInput, readonly RoutedEntityInput[]>();

  return Object.freeze({
    prepare(output: RoutedEntityInput): PreparedRoutedOutput {
      const existing = prepared.get(output);
      if (existing) return existing;
      const reliableIdentity = getReliableOutputIdentity(output);
      reliableIdentities += 1;
      const routeKey = buildRouteOutputKeyWithIdentity(output, reliableIdentity);
      routeKeys += 1;
      outputs += 1;
      const value = Object.freeze({ output, reliableIdentity, routeKey });
      prepared.set(output, value);
      return value;
    },
    split(output: RoutedEntityInput): readonly RoutedEntityInput[] {
      const existing = splitLanes.get(output);
      if (existing) return existing;
      const lanes = Object.freeze(splitRoutedOutputByDeliveryLane(output));
      laneSplits += 1;
      splitLanes.set(output, lanes);
      for (const lane of lanes) splitLanes.set(lane, Object.freeze([lane]));
      return lanes;
    },
    adopt(source: RoutedEntityInput, exactCopy: RoutedEntityInput): void {
      const sourcePrepared = prepared.get(source);
      if (!sourcePrepared) throw new Error('ROUTE_PREPARED_OUTPUT_ADOPT_SOURCE_MISSING');
      prepared.set(exactCopy, Object.freeze({ ...sourcePrepared, output: exactCopy }));
      splitLanes.set(exactCopy, Object.freeze([exactCopy]));
    },
    invalidate(output: RoutedEntityInput): void {
      prepared.delete(output);
    },
    metrics: () => Object.freeze({ outputs, reliableIdentities, routeKeys, laneSplits }),
  });
};
