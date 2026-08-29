import { describe, expect, test } from 'bun:test';
import { existsSync, readFileSync } from 'node:fs';

import {
  WALLET_DEPLOY_VERSION_KEY,
  WalletDeployVersionCoordinator,
  parseWalletDeployVersionPayload,
  resolveWalletDeployVersionAction,
  walletDeployVersionRecoveryMessage,
  type WalletDeployVersionDependencies,
} from '../../../frontend/packages/browser/src/wallet-deploy-version';

type DeployVersionHarness = Readonly<{
  calls: string[];
  coordinator: WalletDeployVersionCoordinator;
  readStored: () => string | null;
}>;

const createDeployVersionHarness = (input: Readonly<{
  currentPayload?: unknown;
  fetchError?: Error;
  resetError?: Error;
  storedVersion?: string;
}> = {}): DeployVersionHarness => {
  const calls: string[] = [];
  const values = new Map<string, string>();
  if (input.storedVersion !== undefined) {
    values.set(WALLET_DEPLOY_VERSION_KEY, input.storedVersion);
  }
  const dependencies: WalletDeployVersionDependencies = {
    durable: {
      getItem: (key) => {
        calls.push(`get:${key}`);
        return values.get(key) ?? null;
      },
      setItem: (key, value) => {
        calls.push(`set:${key}:${value}`);
        values.set(key, value);
      },
    },
    readCurrentPayload: async () => {
      calls.push('fetch');
      if (input.fetchError) throw input.fetchError;
      return input.currentPayload ?? { deployVersion: 'current', ephemeralTestnet: false };
    },
    resetEphemeralTestnet: async () => {
      calls.push('reset');
      if (input.resetError) throw input.resetError;
    },
  };
  return {
    calls,
    coordinator: new WalletDeployVersionCoordinator(dependencies),
    readStored: () => values.get(WALLET_DEPLOY_VERSION_KEY) ?? null,
  };
};

describe('browser wallet deploy version', () => {
  test('parses every supported version field and strict testnet evidence', () => {
    expect(parseWalletDeployVersionPayload({ deployVersion: ' deploy ' })).toEqual({
      version: 'deploy',
      ephemeralTestnet: false,
    });
    expect(parseWalletDeployVersionPayload({ networkVersion: 42 })).toEqual({
      version: '42',
      ephemeralTestnet: false,
    });
    expect(parseWalletDeployVersionPayload({ version: 'v3', ephemeralTestnet: true })).toEqual({
      version: 'v3',
      ephemeralTestnet: true,
    });
  });

  test('rejects malformed or versionless payloads', () => {
    expect(() => parseWalletDeployVersionPayload(null))
      .toThrow('INVALID_DEPLOY_VERSION_PAYLOAD');
    expect(() => parseWalletDeployVersionPayload({ ephemeralTestnet: true }))
      .toThrow('MISSING_DEPLOY_VERSION');
  });

  test('resolves fresh, matching, testnet, and mainnet policies', () => {
    expect(resolveWalletDeployVersionAction('', 'new', true)).toBe('persist-current');
    expect(resolveWalletDeployVersionAction('same', 'same', true)).toBe('continue');
    expect(resolveWalletDeployVersionAction('old', 'new', true)).toBe('reset-ephemeral-testnet');
    expect(resolveWalletDeployVersionAction('old', 'new', false)).toBe('require-recovery');
  });

  test('persists the first validated version without resetting data', async () => {
    const harness = createDeployVersionHarness();

    expect((await harness.coordinator.check()).status).toBe('persist-current');
    expect(harness.readStored()).toBe('current');
    expect(harness.calls).not.toContain('reset');
  });

  test('continues without rewriting a matching version', async () => {
    const harness = createDeployVersionHarness({ storedVersion: 'current' });

    expect((await harness.coordinator.check()).status).toBe('continue');
    expect(harness.calls.filter((call) => call.startsWith('set:'))).toEqual([]);
  });

  test('resets incompatible ephemeral testnet data', async () => {
    const harness = createDeployVersionHarness({
      currentPayload: { deployVersion: 'new', ephemeralTestnet: true },
      storedVersion: 'old',
    });

    expect((await harness.coordinator.check()).status).toBe('reset-ephemeral-testnet');
    expect(harness.calls).toContain('reset');
    expect(harness.readStored()).toBe('old');
  });

  test('requires recovery for incompatible persistent data', async () => {
    const harness = createDeployVersionHarness({
      currentPayload: { deployVersion: 'new' },
      storedVersion: 'old',
    });
    const result = await harness.coordinator.check();

    expect(result.status).toBe('require-recovery');
    if (result.status === 'require-recovery') {
      expect(walletDeployVersionRecoveryMessage(
        result.storedVersion,
        result.current.version,
      )).toContain('Deploy version changed from old to new.');
    }
    expect(harness.calls).not.toContain('reset');
  });

  test('returns fetch and validation failures as explicit unavailable outcomes', async () => {
    const fetchFailure = createDeployVersionHarness({ fetchError: new Error('OFFLINE') });
    const invalidPayload = createDeployVersionHarness({ currentPayload: {} });

    expect((await fetchFailure.coordinator.check()).status).toBe('unavailable');
    expect((await invalidPayload.coordinator.check()).status).toBe('unavailable');
    expect(fetchFailure.calls.some((call) => call.startsWith('get:'))).toBe(false);
    expect(invalidPayload.calls.some((call) => call.startsWith('get:'))).toBe(false);
  });

  test('refreshes and persists only validated current versions', async () => {
    const harness = createDeployVersionHarness({ currentPayload: { version: 'fresh' } });

    expect(await harness.coordinator.refreshStoredVersion()).toEqual({
      version: 'fresh',
      ephemeralTestnet: false,
    });
    expect(harness.readStored()).toBe('fresh');
  });

  test('propagates storage and reset failures', async () => {
    const resetFailure = createDeployVersionHarness({
      currentPayload: { version: 'new', ephemeralTestnet: true },
      resetError: new Error('RESET_FAILED'),
      storedVersion: 'old',
    });
    const storageFailure = new WalletDeployVersionCoordinator({
      durable: {
        getItem: () => { throw new Error('STORAGE_FAILED'); },
        setItem: () => undefined,
      },
      readCurrentPayload: async () => ({ version: 'current' }),
      resetEphemeralTestnet: async () => undefined,
    });

    await expect(resetFailure.coordinator.check()).rejects.toThrow('RESET_FAILED');
    await expect(storageFailure.check()).rejects.toThrow('STORAGE_FAILED');
  });

  test('keeps concrete fetch, logging, and reset wiring in the Svelte shell', () => {
    const boundary = readFileSync(
      'frontend/packages/browser/src/wallet-deploy-version.ts',
      'utf8',
    );
    const layout = readFileSync('frontend/src/routes/app/+layout.svelte', 'utf8');

    expect(boundary).not.toContain('svelte');
    expect(boundary).not.toContain('../../../../core');
    expect(layout).toContain('new WalletDeployVersionCoordinator({');
    expect(layout).toContain('readCurrentPayload: fetchCurrentDeployVersionPayload');
    expect(layout).toContain("reason: 'deploy-version-change-testnet'");
    expect(layout).toContain('await requireWalletDeployVersion().refreshStoredVersion()');
    expect(existsSync('frontend/src/lib/utils/deployVersionPolicy.ts')).toBe(false);
  });
});
