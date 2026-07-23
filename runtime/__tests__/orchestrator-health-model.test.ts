import { expect, test } from 'bun:test';

import { deriveHubRuntimeHealth, deriveResetHealthOk } from '../orchestrator/health-model';

test('orchestrator health treats hub process health separately from relay self-presence', () => {
  const health = deriveHubRuntimeHealth({
    processExitCode: null,
    hasHealth: true,
    hasSelfRelayPresence: false,
    runtimeHalted: false,
  });

  expect(health.online).toBe(true);
  expect(health.selfRelayPresence).toBe(false);
});

test('orchestrator health does not mark hubs online without a live process and health payload', () => {
  expect(deriveHubRuntimeHealth({
    processExitCode: undefined,
    hasHealth: true,
    hasSelfRelayPresence: true,
    runtimeHalted: false,
  }).online).toBe(false);

  expect(deriveHubRuntimeHealth({
    processExitCode: null,
    hasHealth: false,
    hasSelfRelayPresence: true,
    runtimeHalted: false,
  }).online).toBe(false);

  expect(deriveHubRuntimeHealth({
    processExitCode: 1,
    hasHealth: true,
    hasSelfRelayPresence: true,
    runtimeHalted: false,
  }).online).toBe(false);
});

test('orchestrator health fails closed when a live runtime has halted', () => {
  expect(deriveHubRuntimeHealth({
    processExitCode: null,
    hasHealth: true,
    hasSelfRelayPresence: true,
    runtimeHalted: true,
  })).toEqual({
    online: false,
    selfRelayPresence: true,
  });
});

test('orchestrator health latches a reset failure until a fresh reset clears it', () => {
  expect(deriveResetHealthOk({ inProgress: true, lastError: null })).toBe(false);
  expect(deriveResetHealthOk({ inProgress: false, lastError: 'reset failed' })).toBe(false);
  expect(deriveResetHealthOk({ inProgress: false, lastError: null })).toBe(true);
});
