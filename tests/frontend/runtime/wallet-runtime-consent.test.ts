import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';

import {
  remoteAcceptKey,
  type RemoteRuntimeRequest,
} from '../../../frontend/packages/runtime-client/src/remote-runtime-request';
import {
  WALLET_REMOTE_RUNTIME_AUTH_REQUIRED,
  WalletRuntimeConsentCoordinator,
  type WalletRuntimeConsentDependencies,
} from '../../../frontend/packages/browser/src/wallet-runtime-consent';

const existingRequest: RemoteRuntimeRequest = {
  wsUrl: 'wss://runtime.example/rpc',
  authKey: 'xlnra1.admin.existing-capability',
  hostLabel: 'runtime.example',
  keyLabel: 'full capability',
  acceptKey: 'unaccepted',
};

const pastedRequest: RemoteRuntimeRequest = {
  ...existingRequest,
  authKey: '',
  keyLabel: 'capability must be pasted',
  requiresAuthPaste: true,
};

type ConsentHarness = Readonly<{
  calls: string[];
  persisted: RemoteRuntimeRequest[];
  coordinator: WalletRuntimeConsentCoordinator;
}>;

const createConsentHarness = (input: Readonly<{
  activationError?: Error;
  persistenceError?: Error;
  selectionError?: Error;
  stripError?: Error;
}> = {}): ConsentHarness => {
  const calls: string[] = [];
  const persisted: RemoteRuntimeRequest[] = [];
  const dependencies: WalletRuntimeConsentDependencies = {
    publishAuthError: (message) => {
      calls.push(`error:${message}`);
    },
    persistRemoteRequest: (request) => {
      calls.push('persist');
      if (input.persistenceError) throw input.persistenceError;
      persisted.push(request);
    },
    selectEmbeddedRuntime: () => {
      calls.push('select-embedded');
      if (input.selectionError) throw input.selectionError;
    },
    stripRemoteRuntimeParams: () => {
      calls.push('strip');
      if (input.stripError) throw input.stripError;
    },
    activateRuntimeChoice: async () => {
      calls.push('activate');
      if (input.activationError) throw input.activationError;
    },
  };
  return {
    calls,
    persisted,
    coordinator: new WalletRuntimeConsentCoordinator(dependencies),
  };
};

describe('browser wallet Runtime consent', () => {
  test('accepts the request capability without replacing it from the paste field', async () => {
    const harness = createConsentHarness();

    const result = await harness.coordinator.acceptRemote(existingRequest, 'ignored');

    expect(result.status).toBe('accepted');
    expect(harness.persisted).toEqual([{
      ...existingRequest,
      acceptKey: remoteAcceptKey(existingRequest.wsUrl, existingRequest.authKey),
    }]);
    expect(harness.calls).toEqual(['error:', 'persist', 'strip', 'activate']);
  });

  test('trims a pasted capability before persisting and activating it', async () => {
    const harness = createConsentHarness();
    const authKey = 'xlnra1.admin.pasted-capability';

    const result = await harness.coordinator.acceptRemote(pastedRequest, `  ${authKey}  `);

    expect(result).toEqual({
      status: 'accepted',
      request: {
        ...pastedRequest,
        authKey,
        acceptKey: remoteAcceptKey(pastedRequest.wsUrl, authKey),
      },
    });
    expect(harness.persisted).toEqual([{
      ...pastedRequest,
      authKey,
      acceptKey: remoteAcceptKey(pastedRequest.wsUrl, authKey),
    }]);
    expect(harness.calls).toEqual(['error:', 'persist', 'strip', 'activate']);
  });

  test('publishes an actionable error without running acceptance effects', async () => {
    const harness = createConsentHarness();

    expect(await harness.coordinator.acceptRemote(pastedRequest, 'invalid')).toEqual({
      status: 'invalid-auth',
      message: WALLET_REMOTE_RUNTIME_AUTH_REQUIRED,
    });
    expect(harness.persisted).toEqual([]);
    expect(harness.calls).toEqual([`error:${WALLET_REMOTE_RUNTIME_AUTH_REQUIRED}`]);
  });

  test('does not clean the URL or activate when persistence fails', async () => {
    const harness = createConsentHarness({
      persistenceError: new Error('PERSIST_FAILED'),
    });

    await expect(harness.coordinator.acceptRemote(existingRequest, ''))
      .rejects.toThrow('PERSIST_FAILED');
    expect(harness.calls).toEqual(['error:', 'persist']);
  });

  test('does not activate when URL cleanup fails', async () => {
    const harness = createConsentHarness({ stripError: new Error('STRIP_FAILED') });

    await expect(harness.coordinator.acceptRemote(existingRequest, ''))
      .rejects.toThrow('STRIP_FAILED');
    expect(harness.calls).toEqual(['error:', 'persist', 'strip']);
  });

  test('propagates activation failure after durable acceptance effects', async () => {
    const harness = createConsentHarness({
      activationError: new Error('ACTIVATION_FAILED'),
    });

    await expect(harness.coordinator.acceptRemote(existingRequest, ''))
      .rejects.toThrow('ACTIVATION_FAILED');
    expect(harness.calls).toEqual(['error:', 'persist', 'strip', 'activate']);
  });

  test('selects the embedded adapter before cleanup and activation', async () => {
    const harness = createConsentHarness();

    await harness.coordinator.useEmbedded();

    expect(harness.calls).toEqual(['select-embedded', 'strip', 'activate']);
  });

  test('stops embedded cancellation when adapter selection fails', async () => {
    const harness = createConsentHarness({
      selectionError: new Error('SELECTION_FAILED'),
    });

    await expect(harness.coordinator.useEmbedded()).rejects.toThrow('SELECTION_FAILED');
    expect(harness.calls).toEqual(['select-embedded']);
  });

  test('keeps concrete browser and UI effects in the Svelte shell', () => {
    const boundary = readFileSync(
      'frontend/packages/browser/src/wallet-runtime-consent.ts',
      'utf8',
    );
    const layout = readFileSync('frontend/src/routes/app/+layout.svelte', 'utf8');

    expect(boundary).not.toContain('svelte');
    expect(boundary).not.toContain('../../../../core');
    expect(layout).toContain('new WalletRuntimeConsentCoordinator({');
    expect(layout).toContain('persistRemoteRequest: persistRemoteRuntimeRequest');
    expect(layout).toContain('writeEmbeddedRuntimeAdapterSession({ durable: localStorage');
    expect(layout).toContain('activateRuntimeChoice: activateAppAfterRuntimeChoice');
    expect(layout).toContain('await walletRuntimeConsent.acceptRemote(');
    expect(layout).toContain('await walletRuntimeConsent.useEmbedded()');
    expect(layout).not.toContain('remoteAcceptKey(');
  });
});
