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

  test('fresh runtime starts its processor before asynchronous jurisdiction provisioning', () => {
    const source = read('frontend/src/lib/stores/vaultStore.ts');
    const functionStart = source.indexOf('async createRuntime(name: string, seed: string');
    const functionSource = source.slice(functionStart, source.indexOf('\n  // Select runtime', functionStart));
    const createEnv = functionSource.indexOf('newEnv = xln.createEmptyEnv(seed);');
    // The recovery branch starts its restored loop before the fresh-create branch.
    // Anchor this assertion after createEmptyEnv so a valid recovery call cannot
    // masquerade as the fresh runtime processor ordering we are pinning here.
    const startLoop = functionSource.indexOf(
      'ensureRuntimeLoopRunning(newEnv, xln, `create-runtime:',
      createEnv,
    );
    const importJurisdiction = functionSource.indexOf('`createRuntime.importJ(${primaryJurisdictionName})`');

    expect(createEnv).toBeGreaterThan(0);
    expect(startLoop).toBeGreaterThan(createEnv);
    expect(importJurisdiction).toBeGreaterThan(startLoop);
  });

  test('runtime suspension closes ingress and drains accepted work before persistence quiesce', () => {
    const source = read('frontend/src/lib/stores/vaultStore.ts');
    const functionStart = source.indexOf('async function suspendRuntimeEnvActivity(');
    const functionEnd = source.indexOf('\nasync function suspendInactiveRuntimeActivity(', functionStart);
    expect(functionStart).toBeGreaterThan(0);
    expect(functionEnd).toBeGreaterThan(functionStart);
    const functionSource = source.slice(functionStart, functionEnd);

    const stopWatchers = functionSource.indexOf('await xln.stopJurisdictionWatchersAndWait(env);');
    const stopP2P = functionSource.indexOf(
      'await xln.stopP2PAndWait(env, RUNTIME_P2P_SHUTDOWN_TIMEOUT_MS);',
    );
    const drainWork = functionSource.indexOf('await xln.waitForRuntimeWorkDrained(env, 30_000);');
    const pausePersistence = functionSource.indexOf('env.runtimeState.persistencePaused = true;');
    const quiescePersistence = functionSource.indexOf('env.runtimeState.persistenceQuiescing = true;');
    const stopLoop = functionSource.indexOf('await xln.stopRuntimeLoopAndWait(env, 30_000);');

    expect(stopWatchers).toBeGreaterThan(0);
    expect(quiescePersistence).toBeLessThan(stopWatchers);
    expect(drainWork).toBeGreaterThan(quiescePersistence);
    expect(pausePersistence).toBeGreaterThan(drainWork);
    expect(stopLoop).toBeGreaterThan(quiescePersistence);
    expect(stopP2P).toBeGreaterThan(stopLoop);
    expect(source).toContain('const RUNTIME_P2P_SHUTDOWN_TIMEOUT_MS = 10_000;');
  });

  test('page shutdown retains the recovery barrier until accepted work is fully stopped', () => {
    const source = read('frontend/src/lib/stores/vaultStore.ts');
    const operationStart = source.indexOf('async suspendAllRuntimeActivity(): Promise<void>');
    const operationEnd = source.indexOf('\n  async refreshActiveRuntimeFromDbIfBehind()', operationStart);
    expect(operationStart).toBeGreaterThan(0);
    expect(operationEnd).toBeGreaterThan(operationStart);
    const operationSource = source.slice(operationStart, operationEnd);

    const stopRuntime = operationSource.indexOf('await stopRuntimeEnv(');
    const unregisterAfterStop = operationSource.indexOf('unregisterRuntimeEnvChange(runtimeId);', stopRuntime);
    expect(stopRuntime).toBeGreaterThan(0);
    expect(unregisterAfterStop).toBeGreaterThan(stopRuntime);
  });

  test('page unload synchronously fences external ingress before navigation aborts requests', () => {
    const store = read('frontend/src/lib/stores/vaultStore.ts');
    const layout = read('frontend/src/routes/app/+layout.svelte');
    const operationStart = store.indexOf('beginRuntimePageUnload(): void');
    const operationEnd = store.indexOf('\n  async suspendAllRuntimeActivity()', operationStart);

    expect(operationStart).toBeGreaterThan(0);
    expect(operationEnd).toBeGreaterThan(operationStart);
    const operationSource = store.slice(operationStart, operationEnd);
    expect(operationSource).toContain('xln.stopJurisdictionWatchers(env);');
    expect(operationSource).toContain('xln.stopP2P(env);');

    const mountStart = layout.indexOf('onMount(() => {');
    const mountEnd = layout.indexOf('\n  });', mountStart);
    const mountSource = layout.slice(mountStart, mountEnd);
    const pageHideFence = mountSource.indexOf('vaultOperations.beginRuntimePageUnload();');
    const lockInitialization = mountSource.indexOf('initializeActiveTabLock(');

    expect(pageHideFence).toBeGreaterThan(0);
    expect(lockInitialization).toBeGreaterThan(pageHideFence);
    expect(mountSource).toContain("window.addEventListener('pagehide', handlePageHide);");
    expect(mountSource).toContain("window.removeEventListener('pagehide', handlePageHide);");
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

  test('timed lock is scoped to the protection lease that scheduled it', () => {
    const source = read('frontend/src/lib/stores/vaultStore.ts');
    const scheduleStart = source.indexOf('const scheduleVaultLock = (runtime: Runtime)');
    const lockStart = source.indexOf('async lockRuntime(runtimeId: string');
    const selectStart = source.indexOf('\n  // Select runtime', lockStart);
    const scheduleSource = source.slice(scheduleStart, lockStart);
    const lockSource = source.slice(lockStart, selectStart);

    expect(scheduleSource).toContain('vaultOperations.lockRuntime(runtimeId, expectedProtection)');
    expect(lockSource).toContain('readPersistedVaultProtection(normalizedRuntimeId)');
    expect(lockSource).toContain('!sameVaultProtectionLease(expectedProtection, persistedProtection)');
    expect(lockSource).toContain('return;');
    expect(lockSource).toContain('deleteVaultDeviceKey(normalizedRuntimeId, protectionToDelete)');
  });

  test('locked runtimes cannot derive signer keys and render the vault gate', () => {
    const store = read('frontend/src/lib/stores/vaultStore.ts');
    const panel = read('frontend/src/lib/view/UserModePanel.svelte');

    expect(store).toContain('if (!runtime?.seed) return null;');
    expect(store).toContain('if (!runtime?.seed || signerIndex >= runtime.signers.length) return null;');
    expect(panel).toContain('const activeVaultLocked = $derived(');
    expect(panel).toContain('(!hasSigner || activeVaultLocked)');
  });
});
