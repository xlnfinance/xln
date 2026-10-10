import { expect, test } from 'bun:test';
import { classifyRuntimeRecoveryDiscoveryFailure, recoveryFailureErrorText } from '@xln/core/storage/recovery/discovery/failures';
import { recoveryDiscoveryError } from './recovery-failure';

function explain(...messages: string[]): string {
  const failures = messages.map(message => classifyRuntimeRecoveryDiscoveryFailure({
    source: 'tower', sourceLabel: 'https://xln.finance', message,
  }));
  return recoveryDiscoveryError({ failures, errors: failures.filter(f => f.category !== 'ExpectedEmpty').map(recoveryFailureErrorText) }).message;
}

test('a tower outage does not blame the BrainVault credentials', () => {
  // Transport failures arrive coded from the fetch/socket call site.
  for (const failure of [
    'HTTP_503', 'RECOVERY_TOWER_UNREACHABLE: Failed to fetch', 'RECOVERY_TOWER_UNREACHABLE: Load failed',
    'RECOVERY_REQUEST_TIMEOUT: target=0x01',
  ]) {
    expect(explain(failure)).toStartWith('The recovery service is unavailable.');
    expect(explain(failure)).toContain(failure);
  }
});

test('only expected-empty answers establish that no copy was found', () => {
  expect(explain('TOWER_BUNDLE_NOT_FOUND')).toBe('No verified backup could be restored.');
  expect(explain('TOWER_BUNDLE_NOT_FOUND', 'HTTP_503')).toStartWith('The recovery service is unavailable.');
});

test('source-supplied transport words never downgrade contradicting evidence', () => {
  expect(explain('RECOVERY_BUNDLE_TRUSTED_RUNTIME_ID_MISMATCH:derived=0x01:encrypted=network'))
    .toStartWith('The backup could not be verified.');
  expect(explain('Failed to fetch')).toStartWith('The backup could not be verified.');
});

test('invalid evidence takes precedence over a retryable outage', () => {
  const message = explain('HTTP_503', 'RECOVERY_RUNTIME_ID_MISMATCH');
  expect(message).toStartWith('The backup could not be verified.');
  expect(message).toContain('RECOVERY_RUNTIME_ID_MISMATCH');
});

test('missing discovery evidence is never reported as a missing backup', () => {
  expect(explain()).toBe('The backup could not be verified. No recovery data was applied.');
});
