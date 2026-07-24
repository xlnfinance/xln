import { describe, expect, test } from 'bun:test';
import {
  formatE2EGuardFailure,
  matchesBrowserIssue,
  unexpectedBrowserErrors,
  unexpectedOpenIncidents,
  type E2EBrowserIssue,
  type E2EDebugIncident,
} from '../utils/e2e-browser-guard.mts';

const browserIssue = (
  type: E2EBrowserIssue['type'],
  message: string,
  severity: E2EBrowserIssue['severity'] = 'error',
): E2EBrowserIssue => ({
  type,
  severity,
  message,
  url: 'http://127.0.0.1/app',
  method: type === 'requestfailed' ? 'GET' : null,
  status: type === 'http' ? 503 : null,
  testId: 'chromium :: guard',
  timestamp: 1,
});

const incident = (overrides: Partial<E2EDebugIncident> = {}): E2EDebugIncident => ({
  fingerprint: 'runtime-fatal-1',
  state: 'unread',
  source: 'runtime',
  code: 'RUNTIME_FATAL',
  message: 'runtime halted',
  runtimeId: '0x1234',
  lastEventId: 9,
  ...overrides,
});

describe('global E2E browser and incident guard', () => {
  test.each(['console', 'pageerror', 'requestfailed', 'http'] as const)(
    'fails an unexpected %s error',
    (type) => {
      expect(unexpectedBrowserErrors([browserIssue(type, `${type} failed`)]))
        .toHaveLength(1);
    },
  );

  test('does not fail warnings or narrowly expected browser failures', () => {
    expect(unexpectedBrowserErrors([
      browserIssue('console', 'warning', 'warning'),
      browserIssue('console', '[expected] rejected negative path', 'warning'),
    ])).toEqual([]);
  });

  test('matches every browser allowlist field', () => {
    const issue = browserIssue('http', 'HTTP 503');
    expect(matchesBrowserIssue({
      type: 'http',
      severity: 'error',
      message: /503/,
      url: '/app',
      status: 503,
    }, issue)).toBe(true);
    expect(matchesBrowserIssue({ status: 404 }, issue)).toBe(false);
  });

  test('fails every unresolved incident created after the test cursor', () => {
    expect(unexpectedOpenIncidents([incident()], [], [])).toEqual([incident()]);
    expect(unexpectedOpenIncidents([incident({ state: 'acknowledged' })], [], []))
      .toHaveLength(1);
    expect(unexpectedOpenIncidents([incident({ state: 'resolved' })], [], []))
      .toEqual([]);
  });

  test('accepts only a fully matching explicit incident allowlist', () => {
    const current = incident();
    expect(unexpectedOpenIncidents([current], [{
      source: 'runtime',
      code: /^RUNTIME_FATAL$/,
      message: 'halted',
      runtimeId: '0x1234',
    }], [])).toEqual([]);
    expect(unexpectedOpenIncidents([current], [{ code: 'OTHER' }], []))
      .toEqual([current]);
  });

  test('a matched browser allowlist also permits its mirrored browser incident', () => {
    const current = incident({
      source: 'browser',
      code: 'CONSOLE_ERROR',
      message: 'expected negative path',
    });
    expect(unexpectedOpenIncidents(
      [current],
      [],
      [{ type: 'console', severity: 'error', message: 'negative path' }],
    )).toEqual([]);
  });

  test('formats bounded actionable evidence without incident samples', () => {
    const output = formatE2EGuardFailure(
      [browserIssue('pageerror', 'boom')],
      [incident()],
    );
    expect(output).toContain('pageerror');
    expect(output).toContain('RUNTIME_FATAL');
    expect(output).not.toContain('sample');
  });
});
