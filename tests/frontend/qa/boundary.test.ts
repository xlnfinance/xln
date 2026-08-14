import { expect, test } from 'bun:test';
import { decodeQaAuthInfo, decodeQaEnvelope, isQaSummary } from '../../../frontend/src/lib/qa/boundary';

test('QA boundary rejects unknown response keys before UI state is updated', () => {
  expect(() => decodeQaEnvelope({ ok: true, qaAuth: { scope: 'read' }, injected: true }, ['ok', 'qaAuth']),)
    .toThrow('QA_RESPONSE_EXTRA_FIELD');
});

test('QA boundary rejects malformed authorization and summary values', () => {
  expect(() => decodeQaAuthInfo({ scope: 'write' })).toThrow('QA_AUTH_SCOPE_INVALID');
  expect(isQaSummary({
    runId: 'run-1', status: 'passed', createdAt: 'not-a-timestamp', completedAt: null,
    suiteKey: 'suite', suiteLabel: 'Suite', category: 'runtime', failingTargets: [],
  })).toBeFalse();
});
