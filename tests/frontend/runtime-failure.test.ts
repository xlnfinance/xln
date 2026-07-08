import { expect, test } from 'bun:test';

import {
  classifyRuntimeFailure,
  runtimeFailureMessage,
} from '../../frontend/src/lib/utils/runtimeFailure';

test('runtime failure classifier fail-closes unknown errors as fatal', () => {
  expect(classifyRuntimeFailure(new Error('unexpected frame projection fault'))).toEqual({
    kind: 'fatal',
    retryable: false,
    message: 'unexpected frame projection fault',
  });
});

test('runtime failure classifier separates drop defer and debug assert classes', () => {
  expect(classifyRuntimeFailure(new Error('Runtime ingress receipt expired'))).toMatchObject({
    kind: 'drop',
    retryable: false,
  });
  expect(classifyRuntimeFailure(new Error('fetch failed: ECONNREFUSED'))).toMatchObject({
    kind: 'defer',
    retryable: true,
  });
  expect(classifyRuntimeFailure(new Error('Invariant violated: command committed twice'))).toMatchObject({
    kind: 'debug-assert',
    retryable: false,
  });
});

test('runtime failure message compacts object errors without hiding codes', () => {
  expect(runtimeFailureMessage({ name: 'AbortError', code: 'ETIMEDOUT', message: 'request timed out' }))
    .toBe('AbortError: ETIMEDOUT: request timed out');
  expect(runtimeFailureMessage(' '.repeat(8))).toBe('Runtime command failed');
  expect(runtimeFailureMessage(new Error('x '.repeat(200)))).toHaveLength(240);
});
