import { expect, test } from 'bun:test';

import {
  buildProdHealthFailureSummary,
  buildTowerHealthUrl,
  getFatalDegradedReasons,
  getFatalHealthFailures,
  validateHubTopology,
} from '../scripts/prod-health-smoke';

test('prod health smoke ignores advisory bootstrap reserve target drift', () => {
  expect(getFatalDegradedReasons(['bootstrapReserveTargets'])).toEqual([]);
});

test('prod health smoke still fails on real degraded subsystems', () => {
  expect(getFatalDegradedReasons(['storage', 'bootstrapReserveTargets', 'hubMesh'])).toEqual(['storage', 'hubMesh']);
});

test('prod health smoke treats typed fatal failures as authoritative', () => {
  expect(getFatalHealthFailures([
    { category: 'TransientRace', code: 'HUBS_NOT_READY', retryable: true, fatal: false, message: 'internal retry' },
    { category: 'Contradiction', code: 'STORAGE_CORRUPT', retryable: false, fatal: true, message: 'secret path' },
  ])).toEqual([{
    category: 'Contradiction',
    code: 'STORAGE_CORRUPT',
    retryable: false,
    fatal: true,
  }]);
});

test('prod health smoke reports hub relay-presence diagnostics', () => {
  const summary = JSON.parse(buildProdHealthFailureSummary({
    coreOk: false,
    systemOk: false,
    degraded: ['hubs'],
    failures: [{
      category: 'Contradiction',
      code: 'STORAGE_CORRUPT',
      retryable: false,
      fatal: true,
      message: 'internal secret path',
    }],
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
    failures: Array<{ category: string; code: string; retryable: boolean; fatal: boolean }>;
    relayClientCount: number;
    hubs: Array<{ name: string; online: boolean; selfRelayPresence: boolean }>;
    diagnosticMetrics: string[];
  };

  expect(summary.degraded).toEqual(['hubs']);
  expect(summary.failures).toEqual([{
    category: 'Contradiction',
    code: 'STORAGE_CORRUPT',
    retryable: false,
    fatal: true,
  }]);
  expect(summary.relayClientCount).toBe(0);
  expect(summary.hubs[0]).toEqual({ name: 'H1', online: true, selfRelayPresence: false });
  expect(summary.diagnosticMetrics).toContain('xln_child_online{role="hub",name="H1"} 1');
  expect(summary.diagnosticMetrics).not.toContain('irrelevant_metric 123');
  expect(JSON.stringify(summary)).not.toContain('internal secret path');
});

test('prod health smoke validates exact capped-testnet hub topology', () => {
  const health = {
    hubs: [
      { name: 'H1', online: true, selfRelayPresence: true },
      { name: 'H2', online: true, selfRelayPresence: true },
      { name: 'H3', online: true, selfRelayPresence: true },
    ],
  };

  expect(validateHubTopology(health, { expectedHubs: 3, requireHubSelfRelay: true })).toEqual([]);
  expect(validateHubTopology(health, { expectedHubs: 2, requireHubSelfRelay: true }))
    .toContain('EXPECTED_HUB_COUNT_MISMATCH: expected=2 actual=3');
});

test('prod health smoke builds tower health URLs without guessing proxy query shape', () => {
  expect(buildTowerHealthUrl('https://tower.example.com')).toBe('https://tower.example.com/api/tower/healthz');
  expect(buildTowerHealthUrl('https://tower.example.com/api/tower/healthz')).toBe('https://tower.example.com/api/tower/healthz');
  expect(buildTowerHealthUrl('https://xln.finance/api/watchtower-proxy?target=http://127.0.0.1:9100&path=/api/tower/healthz'))
    .toBe('https://xln.finance/api/watchtower-proxy?target=http://127.0.0.1:9100&path=/api/tower/healthz');
});
