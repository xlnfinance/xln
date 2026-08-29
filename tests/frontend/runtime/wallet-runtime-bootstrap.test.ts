import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';

import type { RemoteRuntimeRequest } from '../../../frontend/packages/runtime-client/src/remote-runtime-request';
import {
  WalletRuntimeBootstrapCoordinator,
  hasWalletRuntimeBootstrapInput,
  type WalletRuntimeBootstrapDependencies,
  type WalletRuntimeBootstrapInput,
} from '../../../frontend/packages/browser/src/wallet-runtime-bootstrap';

const remoteRequest: RemoteRuntimeRequest = {
  wsUrl: 'wss://runtime.example/rpc',
  authKey: 'xlnra1.admin.token',
  hostLabel: 'runtime.example',
  keyLabel: 'full capability',
  acceptKey: 'accepted:runtime',
};

const emptyInput = (
  overrides: Partial<WalletRuntimeBootstrapInput> = {},
): WalletRuntimeBootstrapInput => ({
  pairingToken: '',
  importPayload: '',
  importSource: '',
  remoteRequest: null,
  ...overrides,
});

type BootstrapHarness = Readonly<{
  calls: string[];
  coordinator: WalletRuntimeBootstrapCoordinator;
}>;

const createBootstrapHarness = (input: Readonly<{
  consent?: boolean;
  importError?: Error;
  pairingError?: Error;
  persistError?: Error;
}> = {}): BootstrapHarness => {
  const calls: string[] = [];
  const dependencies: WalletRuntimeBootstrapDependencies = {
    pairLocalRuntime: async (token) => {
      calls.push(`pair:${token}`);
      if (input.pairingError) throw input.pairingError;
    },
    importRemoteRuntimes: async ({ payload, source }) => {
      calls.push(`import:${payload}:${source}`);
      if (input.importError) throw input.importError;
    },
    requiresRemoteConsent: (request) => {
      calls.push(`consent:${request.wsUrl}`);
      return input.consent === true;
    },
    publishPendingConsent: (request) => {
      calls.push(`publish:${request.wsUrl}`);
    },
    persistRemoteRequest: (request) => {
      calls.push(`persist:${request.wsUrl}`);
      if (input.persistError) throw input.persistError;
    },
    stripRemoteRuntimeParams: () => {
      calls.push('strip');
    },
  };
  return {
    calls,
    coordinator: new WalletRuntimeBootstrapCoordinator(dependencies),
  };
};

describe('browser wallet Runtime bootstrap', () => {
  test('detects every explicit bootstrap input', () => {
    expect(hasWalletRuntimeBootstrapInput(emptyInput())).toBe(false);
    expect(hasWalletRuntimeBootstrapInput(emptyInput({ pairingToken: 'pair' }))).toBe(true);
    expect(hasWalletRuntimeBootstrapInput(emptyInput({ importPayload: 'payload' }))).toBe(true);
    expect(hasWalletRuntimeBootstrapInput(emptyInput({ importSource: '/source' }))).toBe(true);
    expect(hasWalletRuntimeBootstrapInput(emptyInput({ remoteRequest }))).toBe(true);
  });

  test('keeps pairing and import ordering even without a remote request', async () => {
    const harness = createBootstrapHarness();

    expect(await harness.coordinator.process(emptyInput({
      pairingToken: 'pair',
      importPayload: 'payload',
      importSource: '/source',
    }))).toEqual({ status: 'continue' });
    expect(harness.calls).toEqual(['pair:pair', 'import:payload:/source']);
  });

  test('returns pending consent without persisting the request', async () => {
    const harness = createBootstrapHarness({ consent: true });

    expect(await harness.coordinator.process(emptyInput({ remoteRequest }))).toEqual({
      status: 'pending-consent',
      request: remoteRequest,
    });
    expect(harness.calls).toEqual([
      'pair:',
      'import::',
      `consent:${remoteRequest.wsUrl}`,
      `publish:${remoteRequest.wsUrl}`,
      'strip',
    ]);
  });

  test('persists an accepted request before stripping its URL state', async () => {
    const harness = createBootstrapHarness();

    expect(await harness.coordinator.process(emptyInput({ remoteRequest })))
      .toEqual({ status: 'continue' });
    expect(harness.calls).toEqual([
      'pair:',
      'import::',
      `consent:${remoteRequest.wsUrl}`,
      `persist:${remoteRequest.wsUrl}`,
      'strip',
    ]);
  });

  test('stops before import and request effects when pairing fails', async () => {
    const harness = createBootstrapHarness({ pairingError: new Error('PAIR_FAILED') });

    await expect(harness.coordinator.process(emptyInput({ remoteRequest })))
      .rejects.toThrow('PAIR_FAILED');
    expect(harness.calls).toEqual(['pair:']);
  });

  test('stops before request effects when import fails', async () => {
    const harness = createBootstrapHarness({ importError: new Error('IMPORT_FAILED') });

    await expect(harness.coordinator.process(emptyInput({ remoteRequest })))
      .rejects.toThrow('IMPORT_FAILED');
    expect(harness.calls).toEqual(['pair:', 'import::']);
  });

  test('does not strip request evidence when persistence fails', async () => {
    const harness = createBootstrapHarness({ persistError: new Error('PERSIST_FAILED') });

    await expect(harness.coordinator.process(emptyInput({ remoteRequest })))
      .rejects.toThrow('PERSIST_FAILED');
    expect(harness.calls.at(-1)).toBe(`persist:${remoteRequest.wsUrl}`);
    expect(harness.calls).not.toContain('strip');
  });

  test('keeps concrete import and UI publication effects in the Svelte shell', () => {
    const boundary = readFileSync(
      'frontend/packages/browser/src/wallet-runtime-bootstrap.ts',
      'utf8',
    );
    const layout = readFileSync('frontend/src/routes/app/+layout.svelte', 'utf8');

    expect(boundary).not.toContain('svelte');
    expect(boundary).not.toContain('../../../../core');
    expect(layout).toContain('new WalletRuntimeBootstrapCoordinator({');
    expect(layout).toContain('pairLocalRuntime: pairLocalRuntimeIntoApp');
    expect(layout).toContain('importRemoteRuntimes: importRemoteRuntimesIntoApp');
    expect(layout).toContain('publishPendingConsent: (request) => {');
    expect(layout).toContain('await walletRuntimeBootstrap.process({');
    expect(layout).toContain('await walletRuntimeBootstrap.process(bootstrapInput)');
    expect(layout).toContain("result.status === 'pending-consent'");
  });
});
