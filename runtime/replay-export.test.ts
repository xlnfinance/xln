/**
 * Tests for replay export/import functionality
 */

import { test, expect } from 'bun:test';
import { exportReplay, importReplay, type ReplayExport } from './replay-export';
import type { EnvSnapshot, EntityReplica, EntityState } from './types';

// Helper to create minimal EnvSnapshot for testing
function createTestSnapshot(height: number): EnvSnapshot {
  const replicas = new Map<string, EntityReplica>();

  const entityState: EntityState = {
    entityId: 'entity1',
    height,
    timestamp: Date.now(),
    nonces: new Map([['signer1', 1]]),
    messages: ['test message'],
    proposals: new Map(),
    config: {
      mode: 'proposer-based' as const,
      threshold: 1n,
      validators: ['validator1'],
      shares: { validator1: 1n },
    },
    reserves: new Map([['token1', 1000000n]]),
    accounts: new Map(),
    jBlock: 0,
  };

  const replica: EntityReplica = {
    entityId: 'entity1',
    signerId: 'signer1',
    state: entityState,
    mempool: [],
    isProposer: true,
    position: { x: 0, y: 0, z: 0 },
  };

  replicas.set('entity1', replica);

  return {
    height,
    timestamp: Date.now(),
    replicas,
    runtimeInput: { runtimeTxs: [], entityInputs: [] },
    runtimeOutputs: [],
    description: `Test snapshot ${height}`,
  };
}

test('exportReplay creates valid ReplayExport', () => {
  const history = [createTestSnapshot(0), createTestSnapshot(1), createTestSnapshot(2)];

  const exported = exportReplay(history);

  expect(exported.version).toBe('1.0.0');
  expect(exported.frameCount).toBe(3);
  expect(exported.frames.length).toBe(3);
  expect(typeof exported.exportedAt).toBe('string');
  expect(new Date(exported.exportedAt).getTime()).toBeGreaterThan(0);
});

test('importReplay reconstructs original history', () => {
  const history = [createTestSnapshot(0), createTestSnapshot(1)];

  const exported = exportReplay(history);
  const imported = importReplay(exported);

  expect(imported.length).toBe(history.length);

  // Verify frame heights match
  for (let i = 0; i < imported.length; i++) {
    expect(imported[i].height).toBe(history[i].height);
    expect(imported[i].description).toBe(history[i].description);
  }
});

test('BigInt serialization roundtrip', () => {
  const history = [createTestSnapshot(0)];
  const originalReserves = history[0].replicas.get('entity1')!.state.reserves;

  const exported = exportReplay(history);
  const imported = importReplay(exported);

  const importedReserves = imported[0].replicas.get('entity1')!.state.reserves;

  expect(originalReserves.get('token1')).toBe(1000000n);
  expect(importedReserves.get('token1')).toBe(1000000n);
});

test('Map serialization roundtrip', () => {
  const history = [createTestSnapshot(0)];

  const exported = exportReplay(history);
  const imported = importReplay(exported);

  // Verify replicas Map
  expect(imported[0].replicas.size).toBe(1);
  expect(imported[0].replicas.has('entity1')).toBe(true);

  // Verify nonces Map
  const nonces = imported[0].replicas.get('entity1')!.state.nonces;
  expect(nonces.size).toBe(1);
  expect(nonces.get('signer1')).toBe(1);

  // Verify reserves Map
  const reserves = imported[0].replicas.get('entity1')!.state.reserves;
  expect(reserves.size).toBe(1);
  expect(reserves.get('token1')).toBe(1000000n);
});

test('empty history exports correctly', () => {
  const history: EnvSnapshot[] = [];

  const exported = exportReplay(history);

  expect(exported.frameCount).toBe(0);
  expect(exported.frames.length).toBe(0);

  const imported = importReplay(exported);
  expect(imported.length).toBe(0);
});

test('version compatibility check', () => {
  const mockExport: ReplayExport = {
    version: '2.0.0', // Future version
    exportedAt: new Date().toISOString(),
    frameCount: 0,
    frames: [],
  };

  expect(() => importReplay(mockExport)).toThrow('Unsupported replay version');
});

test('version 1.x.x is supported', () => {
  const mockExport: ReplayExport = {
    version: '1.5.3',
    exportedAt: new Date().toISOString(),
    frameCount: 0,
    frames: [],
  };

  const imported = importReplay(mockExport);
  expect(imported.length).toBe(0);
});

test('optional fields are preserved', () => {
  const history = [createTestSnapshot(0)];
  history[0].title = 'Test Title';
  history[0].narrative = 'Test narrative';
  history[0].viewState = {
    camera: 'orbital',
    zoom: 1.5,
    focus: 'entity1',
  };

  const exported = exportReplay(history);
  const imported = importReplay(exported);

  expect(imported[0].title).toBe('Test Title');
  expect(imported[0].narrative).toBe('Test narrative');
  expect(imported[0].viewState?.camera).toBe('orbital');
  expect(imported[0].viewState?.zoom).toBe(1.5);
  expect(imported[0].viewState?.focus).toBe('entity1');
});
