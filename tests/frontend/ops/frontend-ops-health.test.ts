import { describe, expect, test } from 'bun:test';

import {
  buildOpsHealthMetrics,
  deriveOpsHealthDisplayVerdict,
  decodeOpsHealthEvidence,
  deriveOpsHealthVerdict,
  formatOpsHealthUptime,
  shortOpsHealthHash,
} from '../../../frontend/apps/ops/src/ops-health-model';
import { resolveOpsPage } from '../../../frontend/apps/ops/src/ops-model';

const HEALTH_PAYLOAD = {
  timestamp: 1_777_000_000_000,
  uptime: 3_723_000,
  systemOk: true,
  coreOk: true,
  system: { runtime: true, relay: true, p2p: true },
  process: {
    rssBytes: 64 * 1024 ** 2,
    heapUsedBytes: 16 * 1024 ** 2,
    children: [{ role: 'watchtower', name: 'tower-a', online: true, runtimeId: 'runtime-a' }],
  },
  relay: { activeClientCount: 4, profileCount: 7 },
  disk: { ok: true, freeGiB: 42.25, usedPct: 35.5 },
  source: { height: 811, codeHash: 'abcdef0123456789', owner: 'ops-main' },
  jMachines: [{ lastBlock: 982 }],
  hubMesh: { direct: { openLinkCount: 3 }, pairs: [] },
  storage: {
    tracked: [{
      name: 'runtime-state',
      kind: 'leveldb',
      path: '/var/lib/xln/runtime',
      currentBytes: 4096,
      deltaBytes1h: 1024,
      bytesPerHour: 1024,
      scanMode: 'bounded',
      scanTruncated: false,
    }],
  },
  marketMaker: { enabled: true, ok: true, entityId: 'mm-a', expectedOffersPerHub: 2, startupPhase: 'ready' },
  custody: { enabled: true, ok: true, entityId: 'custody-a', servicePort: 8088 },
};

describe('React ops health evidence', () => {
  test('strictly decodes the canonical health projection', () => {
    const health = decodeOpsHealthEvidence(HEALTH_PAYLOAD, 1);

    expect(health.timestamp).toBe(HEALTH_PAYLOAD.timestamp);
    expect(health.uptimeMs).toBe(3_723_000);
    expect(health.p2pOk).toBe(true);
    expect(health.sourceHeight).toBe(811);
    expect(health.jBlock).toBe(982);
    expect(health.admin.owners.map(owner => owner.role)).toEqual(['watchtower', 'market-maker', 'custody']);
    expect(health.admin.tracked[0]).toMatchObject({ name: 'runtime-state', currentBytes: 4096 });
  });

  test('rejects a non-object health response at the browser boundary', () => {
    expect(() => decodeOpsHealthEvidence('healthy', 1)).toThrow('OPS_HEALTH_RESPONSE_INVALID');
    expect(() => decodeOpsHealthEvidence(null, 1)).toThrow('OPS_HEALTH_RESPONSE_INVALID');
    expect(() => decodeOpsHealthEvidence({}, 1)).toThrow('OPS_HEALTH_RESPONSE_INVALID');
    expect(() => decodeOpsHealthEvidence({ ...HEALTH_PAYLOAD, system: {} }, 1))
      .toThrow('OPS_HEALTH_RESPONSE_INVALID');
  });

  test('derives ready, degraded, and failed verdicts from health plus RPC evidence', () => {
    const health = decodeOpsHealthEvidence(HEALTH_PAYLOAD, 1);
    expect(deriveOpsHealthVerdict(health, { ok: true, attempts: 1, latencyMs: 8, error: null }).status).toBe('READY');
    expect(deriveOpsHealthVerdict(health, null).status).toBe('DEGRADED');
    expect(deriveOpsHealthVerdict(health, { ok: false, attempts: 3, latencyMs: null, error: 'HTTP 503' }))
      .toEqual({ status: 'FAIL', reason: 'RPC health check failed: HTTP 503' });
    expect(deriveOpsHealthVerdict(
      decodeOpsHealthEvidence({ ...HEALTH_PAYLOAD, systemOk: false, degraded: ['relay'] }, 1),
      { ok: true, attempts: 1, latencyMs: 5, error: null },
    )).toEqual({ status: 'FAIL', reason: 'relay' });
    expect(deriveOpsHealthDisplayVerdict(
      health,
      { ok: true, attempts: 1, latencyMs: 5, error: null },
      'Failed to fetch',
    )).toEqual({ status: 'FAIL', reason: 'Latest refresh failed; showing the last verified snapshot' });
  });

  test('formats bounded operator metrics without inventing missing evidence', () => {
    const health = decodeOpsHealthEvidence(HEALTH_PAYLOAD, 1);
    const metrics = buildOpsHealthMetrics(health, { ok: true, attempts: 1, latencyMs: 8, error: null });

    expect(metrics).toHaveLength(12);
    expect(metrics.find(metric => metric.label === 'RPC')).toMatchObject({ value: '8ms', state: 'ok' });
    expect(metrics.find(metric => metric.label === 'RSS')?.value).toBe('64.0 MiB');
    expect(formatOpsHealthUptime(3_723_000)).toBe('1h 2m');
    expect(shortOpsHealthHash('abcdef0123456789-dirty')).toBe('abcdef0123-dirty');
  });

  test('owns health while the QA cockpit is routed to its React surface', () => {
    expect(resolveOpsPage('/health')).toEqual({ kind: 'health', pathname: '/health' });
    expect(resolveOpsPage('/qa')).toEqual({ kind: 'qa', pathname: '/qa' });
    expect(resolveOpsPage('/embed')).toEqual({ kind: 'pending', pathname: '/embed' });
  });
});

describe('React ops health lifecycle wiring', () => {
  test('uses live boundaries, an external store, and explicit page teardown', async () => {
    const [source, page, runtime] = await Promise.all([
      Bun.file('frontend/apps/ops/src/ops-health-source.ts').text(),
      Bun.file('frontend/apps/ops/src/ops-health.tsx').text(),
      Bun.file('frontend/apps/ops/src/ops-health-runtime.ts').text(),
    ]);

    expect(source).toContain("fetch('/api/health'");
    expect(source).toContain('probeRpcHealth()');
    expect(source).toContain('Promise.all');
    expect(source).toContain('controller?.abort()');
    expect(source).toContain('4_000');
    expect(page).toContain('useSyncExternalStore');
    expect(page).toContain('Health evidence could not be refreshed.');
    expect(runtime).toContain("addEventListener('pagehide'");
    expect(runtime).toContain('opsHealthSource.stop()');
  });
});
