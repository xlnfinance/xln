import { describe, expect, test } from 'bun:test';
import { readFile } from 'node:fs/promises';

import {
  NETWORK_DEVICE_DEFINITIONS,
  NETWORK_NODES,
  deriveUnicastFrame,
  getBroadcastDeviceStatus,
  parseNetworkTps,
} from '../../../frontend/apps/site/src/unicast-model';

const REPOSITORY_ROOT = new URL('../../../', import.meta.url);

describe('React unicast pilot', () => {
  test('preserves the canonical 100-participant device mix', () => {
    expect(NETWORK_DEVICE_DEFINITIONS.map(({ type, count, capacityTps }) => ({ type, count, capacityTps }))).toEqual([
      { type: 'phone', count: 70, capacityTps: 10 },
      { type: 'laptop', count: 24, capacityTps: 100 },
      { type: 'server', count: 5, capacityTps: 1_000 },
      { type: 'datacenter', count: 1, capacityTps: 100_000 },
    ]);
    expect(NETWORK_NODES).toHaveLength(100);
    expect(NETWORK_NODES.every(({ x, y }) => x >= 0 && x <= 600 && y >= 0 && y <= 600)).toBe(true);
  });

  test('shows edge strain before broadcast centralizes', () => {
    expect(deriveUnicastFrame(1)).toMatchObject({ broadcastAlive: 100, broadcastPruned: 0, broadcastCentralization: 'distributed' });
    expect(getBroadcastDeviceStatus('phone', 50)).toBe('struggling');
    expect(deriveUnicastFrame(50)).toMatchObject({ broadcastAlive: 100, broadcastPruned: 0, broadcastCentralization: 'edge-strained' });
    expect(deriveUnicastFrame(101)).toMatchObject({ broadcastAlive: 6, broadcastPruned: 94, broadcastCentralization: 'server-only' });
  });

  test('keeps unicast participation and settlement demand constant', () => {
    for (const tps of [1, 10, 100, 1_000]) {
      expect(deriveUnicastFrame(tps)).toMatchObject({ unicastAlive: 100, settlementTps: 1 });
    }
  });

  test('rejects throughput outside the canonical control range', () => {
    expect(parseNetworkTps(1)).toBe(1);
    expect(parseNetworkTps(1_000)).toBe(1_000);
    expect(() => parseNetworkTps(0)).toThrow('UNICAST_TPS_INVALID');
    expect(() => parseNetworkTps(1_001)).toThrow('UNICAST_TPS_INVALID');
    expect(() => parseNetworkTps(1.5)).toThrow('UNICAST_TPS_INVALID');
  });

  test('uses a deterministic visualization instead of random node placement', async () => {
    const model = await readFile(new URL('frontend/apps/site/src/unicast-model.ts', REPOSITORY_ROOT), 'utf8');
    expect(model).not.toContain('Math.random');
    expect(model).not.toContain('Date.now');
  });
});
