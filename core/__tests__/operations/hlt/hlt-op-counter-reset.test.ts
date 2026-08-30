import { expect, test } from 'bun:test';

import {
  assertSocketCounterCoverage,
  decodeHltOpCounterReport,
  findForbiddenHltHubIo,
  hltProcessOpCounterResetTargets,
} from '../../../scripts/operations/hlt/worker-runtime';

const emptyCounterReport = {
  schema: 'xln-hlt-op-counters-v1',
  runId: 'hlt-counter-test',
  hubs: { H1: {}, H2: {}, H3: {} },
};

test('HLT resource ledger resets only the Hub processes in the active run', () => {
  expect(hltProcessOpCounterResetTargets(20_000, [
    { wsUrl: 'ws://127.0.0.1:20010/rpc', label: 'H1' },
  ])).toEqual([
    ['http://127.0.0.1:20010/api/control/performance/op-counters/reset', 'H1'],
  ]);
});

test('raw socket boundary must equal explicit outbound transport bytes', () => {
  const counter = (calls: number, bytes: number) => ({ calls, bytes, durationUs: 0 });
  const exact = new Map([
    ['boundary.socket.send', counter(3, 30)],
    ['socket.direct.out.entity_inputs', counter(2, 20)],
    ['socket.radapter.out.response', counter(1, 10)],
    ['socket.direct.in.entity_inputs', counter(9, 90)],
  ]);
  expect(() => assertSocketCounterCoverage(exact, 'exact')).not.toThrow();
  exact.set('boundary.socket.send', counter(4, 31));
  expect(() => assertSocketCounterCoverage(exact, 'missing')).toThrow('HLT_SOCKET_COUNTER_COVERAGE:missing');
});

test('HLT Hub isolation rejects only measured background I/O', () => {
  expect(findForbiddenHltHubIo(new Map([
    ['boundary.timer.timeoutTick', 1],
    ['socket.relay.out.gossip_request', 2],
    ['boundary.level.get.call', 3],
    ['boundary.http.request', 0],
  ]))).toEqual([
    ['boundary.level.get.call', 3],
    ['socket.relay.out.gossip_request', 2],
  ]);
});

test('HLT op-counter report binds all hubs to one run', () => {
  expect(decodeHltOpCounterReport(emptyCounterReport)).toEqual(emptyCounterReport);
  expect(() => decodeHltOpCounterReport({
    ...emptyCounterReport,
    hubs: { H1: {}, H2: {} },
  })).toThrow('HLT_OP_COUNTER_REPORT_HUB_FIELDS_INVALID');
});
