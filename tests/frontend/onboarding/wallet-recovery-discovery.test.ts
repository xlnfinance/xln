import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';

import {
  WalletRecoveryDiscoveryCoordinator,
  type WalletRecoveryDiscoveryRequest,
} from '../../../frontend/packages/browser/src/wallet-recovery-discovery';

type Discovery = Readonly<{ requestId: string }>;

const deferred = <Value>() => {
  let resolvePromise: ((value: Value) => void) | null = null;
  let rejectPromise: ((error: unknown) => void) | null = null;
  const promise = new Promise<Value>((resolve, reject) => {
    resolvePromise = resolve;
    rejectPromise = reject;
  });
  return {
    promise,
    resolve: (value: Value): void => {
      if (!resolvePromise) throw new Error('DEFERRED_RESOLVE_UNAVAILABLE');
      resolvePromise(value);
    },
    reject: (error: unknown): void => {
      if (!rejectPromise) throw new Error('DEFERRED_REJECT_UNAVAILABLE');
      rejectPromise(error);
    },
  };
};

const request = (runtimeId: string): WalletRecoveryDiscoveryRequest => ({
  seed: `seed:${runtimeId}`,
  runtimeId,
});

describe('browser wallet recovery discovery', () => {
  test('returns the current discovery result with its exact request', async () => {
    const requests: WalletRecoveryDiscoveryRequest[] = [];
    const coordinator = new WalletRecoveryDiscoveryCoordinator({
      discover: async (input: WalletRecoveryDiscoveryRequest): Promise<Discovery> => {
        requests.push(input);
        return { requestId: input.runtimeId };
      },
    });

    expect(await coordinator.run(request('runtime-a'))).toEqual({
      status: 'completed',
      discovery: { requestId: 'runtime-a' },
    });
    expect(requests).toEqual([request('runtime-a')]);
  });

  test('normalizes current Error and non-Error failures', async () => {
    const errorCoordinator = new WalletRecoveryDiscoveryCoordinator({
      discover: async (): Promise<Discovery> => { throw new Error('DISCOVERY_FAILED'); },
    });
    const stringCoordinator = new WalletRecoveryDiscoveryCoordinator({
      discover: async (): Promise<Discovery> => { throw 'STRING_FAILURE'; },
    });

    expect(await errorCoordinator.run(request('runtime-a'))).toEqual({
      status: 'failed',
      message: 'DISCOVERY_FAILED',
    });
    expect(await stringCoordinator.run(request('runtime-b'))).toEqual({
      status: 'failed',
      message: 'STRING_FAILURE',
    });
  });

  test('accepts only the newest overlapping discovery result', async () => {
    const first = deferred<Discovery>();
    const second = deferred<Discovery>();
    const pending = [first, second];
    const coordinator = new WalletRecoveryDiscoveryCoordinator({
      discover: async (): Promise<Discovery> => {
        const next = pending.shift();
        if (!next) throw new Error('DISCOVERY_REQUEST_UNEXPECTED');
        return next.promise;
      },
    });

    const firstRun = coordinator.run(request('runtime-a'));
    const secondRun = coordinator.run(request('runtime-b'));
    second.resolve({ requestId: 'runtime-b' });
    first.resolve({ requestId: 'runtime-a' });

    expect(await secondRun).toEqual({
      status: 'completed',
      discovery: { requestId: 'runtime-b' },
    });
    expect(await firstRun).toEqual({ status: 'cancelled' });
  });

  test('suppresses a stale failure after a newer run starts', async () => {
    const first = deferred<Discovery>();
    const second = deferred<Discovery>();
    const pending = [first, second];
    const coordinator = new WalletRecoveryDiscoveryCoordinator({
      discover: async (): Promise<Discovery> => {
        const next = pending.shift();
        if (!next) throw new Error('DISCOVERY_REQUEST_UNEXPECTED');
        return next.promise;
      },
    });

    const firstRun = coordinator.run(request('runtime-a'));
    const secondRun = coordinator.run(request('runtime-b'));
    first.reject(new Error('STALE_FAILURE'));
    second.resolve({ requestId: 'runtime-b' });

    expect(await firstRun).toEqual({ status: 'cancelled' });
    expect((await secondRun).status).toBe('completed');
  });

  test('explicit invalidation cancels an in-flight discovery', async () => {
    const pending = deferred<Discovery>();
    const coordinator = new WalletRecoveryDiscoveryCoordinator({
      discover: async (): Promise<Discovery> => pending.promise,
    });

    const run = coordinator.run(request('runtime-a'));
    coordinator.invalidate();
    pending.resolve({ requestId: 'runtime-a' });

    expect(await run).toEqual({ status: 'cancelled' });
  });

  test('keeps discovery sources and UI publication in the Svelte event flow', () => {
    const boundary = readFileSync(
      'frontend/packages/browser/src/wallet-recovery-discovery.ts',
      'utf8',
    );
    const view = readFileSync(
      'frontend/src/lib/components/Views/RuntimeCreation.svelte',
      'utf8',
    );

    expect(boundary).not.toContain('svelte');
    expect(boundary).not.toContain('discoverRuntimeRecoveryCandidates');
    expect(boundary).not.toContain('vaultOperations');
    expect(view).toContain('new WalletRecoveryDiscoveryCoordinator<');
    expect(view).toContain('discover: ({ seed, runtimeId }) => discoverRuntimeRecoveryCandidates(seed, {');
    expect(view).toContain('const outcome = await walletRecoveryDiscovery.run({');
    expect(view).toContain("outcome.status === 'cancelled'");
    expect(view).toContain('recoveryErrors = [outcome.message]');
    expect(view).toContain('recoveryCheckedPeers = discovery.checkedPeers');
    expect(view.match(/walletRecoveryDiscovery\.invalidate\(\)/g)).toHaveLength(2);
    expect(view).not.toContain('recoveryRunToken');
  });
});
