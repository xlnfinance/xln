import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const repoRoot = process.cwd();

const read = (path: string) => readFileSync(join(repoRoot, path), 'utf8');

describe('vault runtime creation lock', () => {
  test('createRuntime serializes concurrent creation for the same runtime id', () => {
    const source = read('frontend/src/lib/stores/vaultStore.ts');
    const functionStart = source.indexOf('async createRuntime(name: string, seed: string');
    expect(functionStart).toBeGreaterThan(0);
    const functionSource = source.slice(functionStart, source.indexOf('\n  // Select runtime', functionStart));

    expect(source).toContain('const runtimeCreationInFlight = new Map<string, Promise<void>>();');
    expect(functionSource).toContain('const priorCreation = runtimeCreationInFlight.get(id);');
    expect(functionSource).toContain('await priorCreation.catch(() => undefined);');
    expect(functionSource).toContain('const postCreateState = get(runtimesState);');
    expect(functionSource).toContain('runtimeCreationInFlight.set(id, runtimeCreationBarrier);');
    expect(functionSource).toContain('finishRuntimeCreation();');
    expect(functionSource.indexOf('runtimeCreationInFlight.set(id, runtimeCreationBarrier);'))
      .toBeLessThan(functionSource.indexOf('newEnv = xln.createEmptyEnv(seed);'));
  });
});
