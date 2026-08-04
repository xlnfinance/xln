import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import {
  buildJMachineImportRuntimeInput,
  buildPersistedJMachineConfig,
  normalizeJMachineCreateDetail,
} from '../../frontend/src/lib/components/Jurisdiction/import-jmachine-runtime';
import { deriveJMachineCreatedAt, normalizeJMachineConfig } from '../../frontend/src/lib/stores/jmachineStore';

const draft = {
  name: 'local-sim-visual',
  mode: 'browservm' as const,
  chainId: 31337,
  rpcs: ['https://ignored.example'],
  blockTimeMs: 1_000,
  ticker: 'sim',
};

test('JMachine import builds a RuntimeInput importJ command', () => {
  const input = buildJMachineImportRuntimeInput(draft);

  expect(input.entityInputs).toEqual([]);
  expect(input.runtimeTxs).toEqual([{
    type: 'importJ',
    data: {
      name: 'local-sim-visual',
      chainId: 31337,
      ticker: 'SIM',
      rpcs: [],
      blockTimeMs: 1_000,
    },
  }]);
});

test('JMachine persisted metadata is deterministic and preserves existing createdAt', () => {
  const normalized = normalizeJMachineCreateDetail(draft);
  const first = buildPersistedJMachineConfig(draft);
  const second = buildPersistedJMachineConfig(draft);
  const existing = buildPersistedJMachineConfig(draft, null, { ...first, createdAt: 99 });

  expect(first.createdAt).toBe(deriveJMachineCreatedAt(normalized));
  expect(second.createdAt).toBe(first.createdAt);
  expect(existing.createdAt).toBe(99);
});

test('JMachine config normalization does not depend on wall-clock fallback', () => {
  const config = normalizeJMachineConfig({
    name: 'remote-hub',
    mode: 'rpc',
    chainId: 84532,
    ticker: 'eth',
    rpcs: ['https://base-sepolia.example'],
    blockTimeMs: 2_000,
  });

  expect(config?.createdAt).toBe(deriveJMachineCreatedAt({
    name: 'remote-hub',
    mode: 'rpc',
    chainId: 84532,
    ticker: 'eth',
    rpcs: ['https://base-sepolia.example'],
    blockTimeMs: 2_000,
  }));
});
