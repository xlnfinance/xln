import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';

import {
  deriveMeshChildSeed,
  readMeshSeedOverrides,
  requireMeshRootSeed,
} from '../orchestrator/mesh-seeds';

describe('mesh operator seed derivation', () => {
  test('derives stable domain-separated child secrets without exposing the root', () => {
    const root = '0123456789abcdef'.repeat(4);
    const hub = deriveMeshChildSeed(root, 'runtime:H1');
    expect(hub).toHaveLength(64);
    expect(hub).toBe(deriveMeshChildSeed(root, 'runtime:H1'));
    expect(hub).not.toBe(deriveMeshChildSeed(root, 'runtime:H2'));
    expect(hub).not.toBe(deriveMeshChildSeed(root, 'radapter:H1'));
    expect(hub).not.toContain(root);
  });

  test('fails closed without an operator root seed', () => {
    expect(() => requireMeshRootSeed({})).toThrow('XLN_MESH_ROOT_SEED_MISSING');
  });

  test('accepts explicit named seeds only through a validated override map', () => {
    expect(readMeshSeedOverrides('{"h1":"test-seed"}', 'TEST_SEEDS')).toEqual({ H1: 'test-seed' });
    expect(() => readMeshSeedOverrides('{"h1":""}', 'TEST_SEEDS')).toThrow('TEST_SEEDS_INVALID');
  });

  test('production mesh startup contains no public child runtime seeds', () => {
    const orchestrator = readFileSync('runtime/orchestrator/orchestrator.ts', 'utf8');
    const startup = readFileSync('scripts/start-server.sh', 'utf8');
    expect(orchestrator).not.toContain("seed: 'xln-mesh-mm'");
    expect(orchestrator).not.toContain("seed: 'xln-mesh-custody-seed'");
    expect(orchestrator).not.toContain('seed: `xln-e2e-');
    expect(orchestrator).toContain("runtimeSeedFor('CUSTODY')");
    expect(startup).toContain('xln_read_or_create_operator_seed "$XLN_MESH_ROOT_SEED_FILE"');
  });
});
