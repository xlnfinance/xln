import { expect, test } from 'bun:test';

import { deriveHubRuntimeHealth, deriveResetHealthOk } from '../orchestrator/health-model';

test('orchestrator health treats hub process health separately from relay self-presence', () => {
  const health = deriveHubRuntimeHealth({
    processExitCode: null,
    hasHealth: true,
    hasSelfRelayPresence: false,
  });

  expect(health.online).toBe(true);
  expect(health.selfRelayPresence).toBe(false);
});

test('orchestrator health does not mark hubs online without a live process and health payload', () => {
  expect(deriveHubRuntimeHealth({
    processExitCode: undefined,
    hasHealth: true,
    hasSelfRelayPresence: true,
  }).online).toBe(false);

  expect(deriveHubRuntimeHealth({
    processExitCode: null,
    hasHealth: false,
    hasSelfRelayPresence: true,
  }).online).toBe(false);

  expect(deriveHubRuntimeHealth({
    processExitCode: 1,
    hasHealth: true,
    hasSelfRelayPresence: true,
  }).online).toBe(false);
});

test('orchestrator health never reports reset ready while reset is active or unresolved', () => {
  expect(deriveResetHealthOk({ inProgress: true, lastError: null, resolvedAt: null })).toBe(false);
  expect(deriveResetHealthOk({ inProgress: false, lastError: 'reset failed', resolvedAt: null })).toBe(false);
  expect(deriveResetHealthOk({ inProgress: false, lastError: null, resolvedAt: null })).toBe(true);
  expect(deriveResetHealthOk({ inProgress: false, lastError: 'reset failed', resolvedAt: 1 })).toBe(true);
});
