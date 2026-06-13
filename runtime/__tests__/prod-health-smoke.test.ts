import { expect, test } from 'bun:test';

import { buildProdHealthFailureSummary, getFatalDegradedReasons } from '../scripts/prod-health-smoke';

test('prod health smoke ignores advisory bootstrap reserve target drift', () => {
  expect(getFatalDegradedReasons(['bootstrapReserveTargets'])).toEqual([]);
});

test('prod health smoke still fails on real degraded subsystems', () => {
  expect(getFatalDegradedReasons(['storage', 'bootstrapReserveTargets', 'hubMesh'])).toEqual(['storage', 'hubMesh']);
});

test('prod health smoke reports hub relay-presence diagnostics', () => {
  const summary = JSON.parse(buildProdHealthFailureSummary({
    coreOk: false,
    systemOk: false,
    degraded: ['hubs'],
    relay: { clientCount: 0 },
    hubMesh: { ok: true },
    marketMaker: { ok: true, startupPhase: 'offers-ready' },
    hubs: [
      { name: 'H1', online: true, selfRelayPresence: false },
      { name: 'H2', online: true, selfRelayPresence: false },
    ],
  }, [
    'xln_core_ok 0',
    'xln_child_online{role="hub",name="H1"} 1',
    'xln_hub_self_relay_presence{name="H1"} 0',
    'irrelevant_metric 123',
  ].join('\n'))) as {
    degraded: string[];
    relayClientCount: number;
    hubs: Array<{ name: string; online: boolean; selfRelayPresence: boolean }>;
    diagnosticMetrics: string[];
  };

  expect(summary.degraded).toEqual(['hubs']);
  expect(summary.relayClientCount).toBe(0);
  expect(summary.hubs[0]).toEqual({ name: 'H1', online: true, selfRelayPresence: false });
  expect(summary.diagnosticMetrics).toContain('xln_child_online{role="hub",name="H1"} 1');
  expect(summary.diagnosticMetrics).not.toContain('irrelevant_metric 123');
});
