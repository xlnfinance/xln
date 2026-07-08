import { expect, test } from 'bun:test';
import { readFileSync } from 'fs';

import {
  buildRecoveryTowerStatuses,
  buildRuntimeRecoveryCoverage,
  formatRecoveryBytes,
} from '../../frontend/src/lib/utils/recoveryCoverage';
import {
  clearRuntimeRecoveryDiscoveryStatus,
  readRuntimeRecoveryDiscoveryStatus,
  writeRuntimeRecoveryDiscoveryStatus,
} from '../../frontend/src/lib/utils/recoveryDiscoveryStatus';
import type { Runtime } from '../../frontend/src/lib/stores/vaultStore';

const runtimeFixture = (recovery: Runtime['recovery'] = {}): Runtime => ({
  id: '0x1111111111111111111111111111111111111111',
  label: 'Test runtime',
  seed: 'test test test test test test test test test test test junk',
  signers: [],
  activeSignerIndex: 0,
  recovery,
  createdAt: 1,
});

const byId = (items: ReturnType<typeof buildRuntimeRecoveryCoverage>) =>
  Object.fromEntries(items.map((item) => [item.id, item]));

const installMemoryLocalStorage = (): void => {
  const values = new Map<string, string>();
  Object.defineProperty(globalThis, 'localStorage', {
    configurable: true,
    value: {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => values.set(key, value),
      removeItem: (key: string) => values.delete(key),
      clear: () => values.clear(),
      key: (index: number) => Array.from(values.keys())[index] ?? null,
      get length() {
        return values.size;
      },
    } as Storage,
  });
};

test('runtime recovery coverage shows local state and missing remote coverage honestly', () => {
  const coverage = byId(buildRuntimeRecoveryCoverage({
    runtime: runtimeFixture(),
    runtimeHeight: 12,
  }));

  expect(coverage.local_state).toMatchObject({
    status: 'ready',
    statusLabel: 'Available',
    detail: 'Browser runtime at h12',
  });
  expect(coverage.tower_backup).toMatchObject({
    status: 'missing',
    statusLabel: 'Off',
  });
  expect(coverage.last_resort).toMatchObject({
    status: 'missing',
    statusLabel: 'Off',
  });
  expect(coverage.peer_refresh).toMatchObject({
    status: 'missing',
    statusLabel: 'Not available',
  });
});

test('runtime recovery coverage reports saved remote runtime peer refresh sources', () => {
  const configured = byId(buildRuntimeRecoveryCoverage({
    runtime: runtimeFixture(),
    peerSourceCount: 2,
  }));

  expect(configured.peer_refresh).toMatchObject({
    status: 'configured',
    statusLabel: 'Configured',
    detail: '2 saved remote runtimes available for restore checks',
  });

  const observed = byId(buildRuntimeRecoveryCoverage({
    runtime: runtimeFixture(),
    peerSourceCount: 2,
    discovery: {
      checkedPeers: 2,
      peerBackupCount: 1,
    },
  }));

  expect(observed.peer_refresh).toMatchObject({
    status: 'ready',
    statusLabel: 'Backup observed',
    detail: '1 peer backup from 2 remote runtimes',
  });
});

test('runtime recovery coverage surfaces typed peer refresh failures', () => {
  const empty = byId(buildRuntimeRecoveryCoverage({
    runtime: runtimeFixture(),
    peerSourceCount: 2,
    discovery: {
      checkedPeers: 2,
      peerBackupCount: 0,
      failures: [{
        source: 'peer',
        sourceLabel: 'Peer Empty',
        category: 'ExpectedEmpty',
        code: 'PEER_RECOVERY_BUNDLE_EMPTY',
        message: 'peer did not have a backup bundle',
      }],
    },
  }));

  expect(empty.peer_refresh).toMatchObject({
    status: 'configured',
    statusLabel: 'No backup',
    detail: '2 remote runtimes checked · no peer backup found (PEER_RECOVERY_BUNDLE_EMPTY)',
  });

  const transient = byId(buildRuntimeRecoveryCoverage({
    runtime: runtimeFixture(),
    peerSourceCount: 1,
    discovery: {
      checkedPeers: 1,
      peerBackupCount: 0,
      failures: [{
        source: 'peer',
        sourceLabel: 'Peer Slow',
        category: 'TransientRace',
        code: 'RECOVERY_REQUEST_TIMEOUT',
        message: 'request timeout',
      }],
    },
  }));

  expect(transient.peer_refresh).toMatchObject({
    status: 'configured',
    statusLabel: 'Retry pending',
    detail: '1 remote runtime checked · peer refresh retry pending (RECOVERY_REQUEST_TIMEOUT)',
  });

  const contradiction = byId(buildRuntimeRecoveryCoverage({
    runtime: runtimeFixture(),
    peerSourceCount: 1,
    discovery: {
      checkedPeers: 1,
      peerBackupCount: 0,
      failures: [{
        source: 'peer',
        sourceLabel: 'Peer Wrong',
        category: 'Contradiction',
        code: 'RECOVERY_CANDIDATE_RUNTIME_ID_MISMATCH',
        message: 'candidate runtime id mismatch',
      }],
    },
  }));

  expect(contradiction.peer_refresh).toMatchObject({
    status: 'configured',
    statusLabel: 'Check failed',
    detail: '1 remote runtime checked · peer refresh failed (RECOVERY_CANDIDATE_RUNTIME_ID_MISMATCH)',
  });
});

test('runtime recovery discovery status persists peer refresh counters', () => {
  installMemoryLocalStorage();
  const runtimeId = '0x1111111111111111111111111111111111111111';

  writeRuntimeRecoveryDiscoveryStatus({
    runtimeId,
    checkedTowers: 1,
    checkedPeers: 2,
    peerBackupCount: 1,
    backupCount: 3,
    errors: ['peer-a:timeout'],
    failures: [{
      source: 'peer',
      sourceLabel: 'peer-a',
      category: 'TransientRace',
      code: 'RECOVERY_REQUEST_TIMEOUT',
      message: 'timeout',
    }],
    checkedAt: 123,
  });

  expect(readRuntimeRecoveryDiscoveryStatus(runtimeId)).toEqual({
    runtimeId,
    checkedTowers: 1,
    checkedPeers: 2,
    peerBackupCount: 1,
    backupCount: 3,
    errors: ['peer-a:timeout'],
    failures: [{
      source: 'peer',
      sourceLabel: 'peer-a',
      category: 'TransientRace',
      code: 'RECOVERY_REQUEST_TIMEOUT',
      message: 'timeout',
    }],
    checkedAt: 123,
  });

  clearRuntimeRecoveryDiscoveryStatus(runtimeId);
  expect(readRuntimeRecoveryDiscoveryStatus(runtimeId)).toBeNull();
});

test('runtime recovery coverage distinguishes configured towers from observed receipts', () => {
  const configured = byId(buildRuntimeRecoveryCoverage({
    runtime: runtimeFixture(),
    towers: [{
      id: 'tower-1',
      url: 'https://tower.example.com/',
      towerMode: 'delayed_last_resort',
      enabled: true,
    }],
  }));

  expect(configured.tower_backup).toMatchObject({
    status: 'configured',
    statusLabel: 'Configured',
  });
  expect(configured.last_resort).toMatchObject({
    status: 'configured',
    statusLabel: 'Configured',
  });

  const observed = byId(buildRuntimeRecoveryCoverage({
    runtime: runtimeFixture({
      lastKnownStoredBytes: 4096,
      lastTowerReceipts: [
        {
          towerUrl: 'https://tower.example.com',
          towerMode: 'blind_backup',
          height: 10,
          bundleHash: `0x${'11'.repeat(32)}`,
          sequence: 1,
          receivedAt: 100,
          storedBytes: 4096,
        },
        {
          towerUrl: 'https://tower.example.com',
          towerMode: 'delayed_last_resort',
          height: 10,
          bundleHash: `0x${'22'.repeat(32)}`,
          sequence: 2,
          receivedAt: 101,
        },
      ],
    }),
    towers: [{
      id: 'tower-1',
      url: 'https://tower.example.com/',
      towerMode: 'delayed_last_resort',
      enabled: true,
    }],
  }));

  expect(observed.tower_backup).toMatchObject({
    status: 'ready',
    statusLabel: 'Receipt observed',
  });
  expect(observed.tower_backup?.detail).toContain('h10');
  expect(observed.tower_backup?.detail).toContain('4.0 KB stored');
  expect(observed.last_resort).toMatchObject({
    status: 'ready',
    statusLabel: 'Receipt observed',
  });
});

test('runtime recovery coverage dedupes disabled and duplicate towers', () => {
  const coverage = byId(buildRuntimeRecoveryCoverage({
    runtime: runtimeFixture({ lastKnownStoredBytes: 1536, lastQuotaWarningAt: 7 }),
    towers: [
      { url: 'https://tower.example.com/', towerMode: 'blind_backup', enabled: true },
      { url: 'https://tower.example.com', towerMode: 'delayed_last_resort', enabled: true },
      { url: 'https://off.example.com', towerMode: 'delayed_last_resort', enabled: false },
    ],
  }));

  expect(coverage.tower_backup?.detail).toContain('1 service');
  expect(coverage.last_resort?.detail).toContain('1 disputer configured');
  expect(coverage.last_resort?.detail).toContain('quota warning');
});

test('recovery tower statuses prefer current failures over stale receipts', () => {
  const statuses = buildRecoveryTowerStatuses(runtimeFixture({
    lastTowerReceipts: [{
      towerUrl: 'https://tower.example.com',
      towerMode: 'blind_backup',
      height: 8,
      bundleHash: `0x${'11'.repeat(32)}`,
      sequence: 1,
      receivedAt: 100,
      storedBytes: 2048,
    }],
    lastTowerFailures: [{
      towerUrl: 'https://tower.example.com',
      towerMode: 'blind_backup',
      checkedAt: 110,
      error: 'HTTP_500',
    }],
  }), [{ url: 'https://tower.example.com/', towerMode: 'delayed_last_resort' }]);

  expect(statuses).toEqual([{
    url: 'https://tower.example.com',
    status: 'failure',
    label: 'Last upload failed',
    detail: 'HTTP_500',
  }]);

  const recovered = buildRecoveryTowerStatuses(runtimeFixture({
    lastTowerReceipts: [{
      towerUrl: 'https://tower.example.com',
      towerMode: 'blind_backup',
      height: 9,
      bundleHash: `0x${'22'.repeat(32)}`,
      sequence: 2,
      receivedAt: 120,
      storedBytes: 2048,
    }],
    lastTowerFailures: [{
      towerUrl: 'https://tower.example.com',
      towerMode: 'blind_backup',
      checkedAt: 110,
      error: 'HTTP_500',
    }],
  }), [{ url: 'https://tower.example.com/', towerMode: 'delayed_last_resort' }]);

  expect(recovered[0]).toMatchObject({
    status: 'receipt',
    label: 'Receipt observed',
    detail: 'h9 · seq 2 · 2.0 KB',
  });
});

test('recovery settings panel renders the coverage grid inside existing recovery UI', () => {
  const source = readFileSync('frontend/src/lib/components/Entity/EntitySettingsProjectionPanel.svelte', 'utf8');
  expect(source).toContain('buildRuntimeRecoveryCoverage');
  expect(source).toContain('buildRecoveryTowerStatuses');
  expect(source).toContain('readRuntimeRecoveryDiscoveryStatus(activeRecoveryRuntimeId)');
  expect(source).toContain('buildRemoteRuntimeRecoveryPeerSources({ runtimeId: activeRecoveryRuntimeId }).length');
  expect(source).toContain('peerSourceCount: recoveryPeerSourceCount');
  expect(source).toContain('discovery: recoveryDiscoveryStatus');
  expect(source).toContain('data-testid="recovery-coverage-grid"');
  expect(source).toContain('data-testid={`recovery-coverage-${item.id}`}');
  expect(source).toContain('class="recovery-service-status"');
});

test('formatRecoveryBytes keeps recovery coverage labels compact', () => {
  expect(formatRecoveryBytes(0)).toBe('0 B');
  expect(formatRecoveryBytes(64)).toBe('64 B');
  expect(formatRecoveryBytes(1536)).toBe('1.5 KB');
  expect(formatRecoveryBytes(2 * 1024 * 1024)).toBe('2.0 MB');
});
