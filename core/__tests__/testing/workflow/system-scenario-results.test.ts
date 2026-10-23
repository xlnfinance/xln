import { expect, test } from 'bun:test';
import {
  parseArgs,
  summarizeSystemScenarioResults,
  type RunResult,
} from '../../../scripts/e2e/runners/run-system-tests-parallel';

test('system runner rejects duplicate scenario names before starting work', () => {
  expect(() => parseArgs(['--scenarios=processbatch, processbatch'])).toThrow('DUPLICATE_SYSTEM_SCENARIO');
  expect(parseArgs(['--scenarios=processbatch,rebalance']).scenarios).toEqual(['processbatch', 'rebalance']);
});

test('a later passing result cannot erase an earlier failure of the same scenario', () => {
  const base = { scenario: 'processbatch', workerId: 0, port: 18545, durationMs: 1, logPath: '/unused' };
  const failure: RunResult = { ...base, status: 'failed', error: 'exact boundary failed' };
  const pass: RunResult = { ...base, workerId: 1, status: 'passed' };
  const summary = summarizeSystemScenarioResults(['processbatch', 'processbatch'], [failure, pass]);
  expect(summary.failed).toEqual([failure]);
  expect(summary.ordered).toEqual([failure, pass]);
});

test('summary preserves scenario order independently of completion order', () => {
  const first: RunResult = {
    scenario: 'first',
    workerId: 0,
    port: 18545,
    durationMs: 2,
    logPath: '/unused',
    status: 'passed',
  };
  const second: RunResult = { ...first, scenario: 'second', workerId: 1, durationMs: 1 };
  expect(summarizeSystemScenarioResults(['first', 'second'], [second, first])).toEqual({
    ordered: [first, second],
    failed: [],
  });
});
