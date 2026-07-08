import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const repoRoot = process.cwd();

const read = (path: string) => readFileSync(join(repoRoot, path), 'utf8');

describe('vault runtime creation lock', () => {
  test('default jurisdiction import names preserve configured labels', () => {
    const source = read('frontend/src/lib/stores/vaultStore.ts');
    const functionStart = source.indexOf('const resolveDefaultJurisdictionImportName = (');
    expect(functionStart).toBeGreaterThan(0);
    const functionSource = source.slice(functionStart, source.indexOf('\n};', functionStart) + 3);

    expect(functionSource).toContain('const rawName = String(config.name || key).trim();');
    expect(functionSource).not.toContain("return 'Testnet'");
    expect(functionSource).not.toContain("return 'Tron'");
    expect(functionSource).not.toContain("chainId === 31337");
    expect(source).not.toContain('stripLocalJurisdictionSuffix');
  });

  test('primary jurisdiction selection does not depend on arrakis key', () => {
    const source = read('frontend/src/lib/stores/vaultStore.ts');
    const functionStart = source.indexOf('const resolveJurisdictionConfig = (');
    const functionEnd = source.indexOf('const resolveDefaultJurisdictionImportName = (', functionStart);
    expect(functionStart).toBeGreaterThan(0);
    expect(functionEnd).toBeGreaterThan(functionStart);
    const functionSource = source.slice(functionStart, functionEnd);

    expect(functionSource).toContain('const usable = Object.values(jurisdictions.jurisdictions || {}).filter(hasUsableJurisdictionConfig);');
    expect(functionSource).toContain('usable.find(isPrimaryJurisdictionConfig) ?? usable[0]');
    expect(source).toContain('const isPrimaryJurisdictionConfig = (config: ApiJurisdictionConfig): boolean =>');
    expect(source).toContain('config.primary === true');
    expect(source).not.toContain("map['arrakis']");
    expect(source).not.toContain('arrakisConfig');
  });

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

  test('runtime restore does not rewrite legacy signer jurisdiction labels', () => {
    const source = read('frontend/src/lib/stores/vaultStore.ts');
    const restoreStart = source.indexOf('async function buildOrRestoreRuntimeEnv(runtime: Runtime');
    const restoreEnd = source.indexOf('\nfunction registerRuntimeResumeListener', restoreStart);
    expect(restoreStart).toBeGreaterThan(0);
    expect(restoreEnd).toBeGreaterThan(restoreStart);
    const restoreSource = source.slice(restoreStart, restoreEnd);

    expect(restoreSource).toContain('const preferredJurisdictionName = String(signer.jurisdiction || primaryJurisdictionName).trim();');
    expect(restoreSource).toContain('const jReplica = findJReplicaByName(env, preferredJurisdictionName);');
    expect(restoreSource).not.toContain("normalizeJurisdictionKey(preferredJurisdictionName) === 'testnet'");
    expect(restoreSource).not.toContain('signer.jurisdiction = primaryJurisdictionName');
  });
});
