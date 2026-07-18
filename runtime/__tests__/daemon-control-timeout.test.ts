import { expect, test } from 'bun:test';

import { CONTROL_RUNTIME_INPUT_OBSERVATION_TIMEOUT_MS } from '../orchestrator/daemon-control';

test('daemon control allows one minute for an accepted runtime input to commit', () => {
  expect(CONTROL_RUNTIME_INPUT_OBSERVATION_TIMEOUT_MS).toBe(60_000);
});
