import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';

import {
  resolveWalletBrowserDiagnostics,
  resolveWalletDeployVersionDiagnostic,
  unavailableWalletDeployVersionDiagnostic,
} from '../../../frontend/apps/wallet/src/wallet-diagnostics-model';

describe('React wallet diagnostics', () => {
  test('reports actual supported browser capabilities without invented health', () => {
    const diagnostics = resolveWalletBrowserDiagnostics({
      online: true,
      secureContext: true,
      dedicatedWorkers: true,
      webLocks: true,
      serviceWorkers: false,
      localStorageReadable: true,
      persistedStorage: false,
      persistedStorageError: '',
    });
    expect(diagnostics).toHaveLength(7);
    expect(diagnostics.map(({ label, value, tone }) => ({ label, value, tone }))).toEqual([
      { label: 'Network', value: 'Online', tone: 'ok' },
      { label: 'Secure context', value: 'Available', tone: 'ok' },
      { label: 'Dedicated workers', value: 'Available', tone: 'ok' },
      { label: 'Cross-tab lock', value: 'Available', tone: 'ok' },
      { label: 'PWA worker', value: 'Unavailable', tone: 'neutral' },
      { label: 'Local storage', value: 'Readable', tone: 'ok' },
      { label: 'Durable storage', value: 'Best effort', tone: 'neutral' },
    ]);
  });

  test('publishes blocked and unavailable browser states with diagnostics', () => {
    const diagnostics = resolveWalletBrowserDiagnostics({
      online: false,
      secureContext: false,
      dedicatedWorkers: false,
      webLocks: false,
      serviceWorkers: false,
      localStorageReadable: false,
      persistedStorage: null,
      persistedStorageError: 'Persistence status failed: denied',
    });
    expect(diagnostics.slice(0, 4).every(({ tone }) => tone === 'attention')).toBe(true);
    expect(diagnostics[5]).toMatchObject({ value: 'Blocked', tone: 'attention' });
    expect(diagnostics[6]).toMatchObject({
      value: 'Unknown',
      detail: 'Persistence status failed: denied',
    });
  });

  test('distinguishes untracked, aligned, and changed deploy versions', () => {
    expect(resolveWalletDeployVersionDiagnostic('', { deployVersion: 'release-2' }))
      .toMatchObject({ status: 'untracked', currentVersion: 'release-2' });
    expect(resolveWalletDeployVersionDiagnostic('release-2', { networkVersion: 'release-2' }))
      .toEqual({
        status: 'aligned',
        storedVersion: 'release-2',
        currentVersion: 'release-2',
        message: 'Stored browser metadata matches the current deployment.',
      });
    expect(resolveWalletDeployVersionDiagnostic('release-1', {
      version: 'release-2',
      ephemeralTestnet: false,
    })).toMatchObject({ status: 'changed', storedVersion: 'release-1' });
    expect(resolveWalletDeployVersionDiagnostic('release-1', {
      version: 'release-2',
      ephemeralTestnet: true,
    }).message).toContain('ephemeral testnet');
  });

  test('fails closed for malformed or unavailable deploy metadata', () => {
    expect(() => resolveWalletDeployVersionDiagnostic('release-1', {}))
      .toThrow('MISSING_DEPLOY_VERSION');
    expect(unavailableWalletDeployVersionDiagnostic('release-1', new Error('gateway down')))
      .toEqual({
        status: 'unavailable',
        storedVersion: 'release-1',
        currentVersion: 'Unavailable',
        message: 'Deploy version check failed: gateway down',
      });
  });

  test('keeps the report redacted and refreshes through the canonical endpoint', () => {
    const source = readFileSync('frontend/apps/wallet/src/wallet-diagnostics.tsx', 'utf8');
    expect(source).toContain('/api/jurisdictions?ts=');
    expect(source).toContain("cache: 'no-store'");
    expect(source).toContain('navigator.storage.persisted()');
    expect(source).toContain('new AbortController()');
    expect(source).toContain('activeRequest.current?.abort()');
    expect(source).toContain('Configuration, not a connection handshake');
    expect(source).not.toContain('sessionKey');
    expect(source).not.toContain('authKey');
    expect(source).not.toContain('passphrase');
    expect(source).not.toContain('mnemonicInput');
    expect(source).not.toContain('privateKey');
    expect(source).not.toContain('RuntimeState');
  });
});
