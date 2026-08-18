import { describe, expect, test } from 'bun:test';
import { buildPendingNetworkOutputs } from '../../../runtime/delivery/pending';
import { createPreparedOutputGraph } from '../../../runtime/delivery/prepared-output';
import type { RoutedEntityInput } from '../../../runtime/types';

const entityId = (index: number): string => `0x${index.toString(16).padStart(64, '0')}`;

const outputs = (count: number): RoutedEntityInput[] => Array.from({ length: count }, (_, index) => ({
  entityId: entityId(index + 1),
  signerId: '0x1111111111111111111111111111111111111111',
  runtimeId: '0x2222222222222222222222222222222222222222',
  sourceRuntimeFrame: { height: 7, timestamp: 70 },
  entityTxs: [],
}));

describe('frame-local prepared output graph', () => {
  test('keeps 64 route keys stable across pending normalization passes', () => {
    const graph = createPreparedOutputGraph();
    const first = buildPendingNetworkOutputs(outputs(64), graph);
    const second = buildPendingNetworkOutputs(first, graph);

    expect(second.map(output => output.entityId)).toEqual(first.map(output => output.entityId));
    expect(second.map(output => graph.prepare(output).routeKey)).toEqual(
      first.map(output => graph.prepare(output).routeKey),
    );
  });

  test('copies only the routed merge shell and preserves immutable consensus payload identity', () => {
    const original = outputs(1)[0]!;
    const [pending] = buildPendingNetworkOutputs([original]);

    expect(pending).not.toBe(original);
    expect(pending?.sourceRuntimeFrame).toBe(original.sourceRuntimeFrame);
  });
});
