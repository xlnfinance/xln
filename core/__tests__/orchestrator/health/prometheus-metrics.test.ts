import { describe, expect, test } from 'bun:test';

import type { AggregatedHealth } from '../../../orchestrator/orchestrator-types';
import { buildPrometheusMetrics } from '../../../orchestrator/prometheus';

// Only the fields the metrics builder reads.
const health = {
  coreOk: true,
  systemOk: true,
  degraded: [],
  reset: { inProgress: false },
  relay: { clientCount: 4, externalClientIds: ['a', 'b'], marketSubscriptions: { total: 1 } },
  process: {
    uptimeSec: 10,
    rssBytes: 100,
    heapUsedBytes: 50,
    children: [{ role: 'hub', name: 'H1', online: true, restartCount: 3 }],
  },
  disk: { freeBytes: 123_456_789, usedPct: 40 },
  storage: {
    ok: true,
    tracked: [{ name: 'h1-db', kind: 'dir', currentBytes: 999, bytesPerHour: 5, scanTruncated: false }],
  },
  hubMesh: { ok: true, direct: { openLinkCount: 2 } },
  marketMaker: { ok: true },
  custody: { enabled: false, ok: false },
  bootstrapReserves: { ok: true, targetMet: true },
  hubs: [{ name: 'H1', online: true, selfRelayPresence: true, restartCount: 3 }],
  timings: { reset: { startedAt: 1, completedAt: 2, ms: 1 } },
} as unknown as AggregatedHealth;

const OPERATOR_ONLY = [
  'xln_relay_external_clients',
  'xln_disk_free_bytes',
  'xln_child_online',
  'xln_child_restart_total',
  'xln_hub_restart_total',
  'xln_storage_tracked_bytes',
  'xln_storage_scan_truncated',
];

describe('orchestrator Prometheus metrics', () => {
  test('a public caller gets the same redaction as /api/health', () => {
    const metrics = buildPrometheusMetrics(health, false);
    expect(metrics).toContain('xln_core_ok 1');
    expect(metrics).toContain('xln_hub_online{name="H1"} 1');
    expect(metrics).toContain('xln_orchestrator_stage_ms{stage="reset"} 1');
    for (const name of OPERATOR_ONLY) expect(metrics).not.toContain(name);
    expect(metrics).not.toContain('h1-db');
  });

  test('an operator gets the full diagnostics', () => {
    const metrics = buildPrometheusMetrics(health, true);
    for (const name of OPERATOR_ONLY) expect(metrics).toContain(name);
    expect(metrics).toContain('xln_child_restart_total{role="hub",name="H1"} 3');
    expect(metrics).toContain('xln_storage_tracked_bytes{name="h1-db",kind="dir"} 999');
  });
});
