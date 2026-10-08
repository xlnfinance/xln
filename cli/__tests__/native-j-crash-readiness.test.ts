import { expect, test } from 'bun:test';
import { isNativeCrashProofReady } from '../scripts/native-j-submit-crash-proof';

test('crash injection waits for the whole orchestrator bootstrap, not only bilateral mesh', () => {
  expect(isNativeCrashProofReady({ hubMesh: { ok: true }, systemOk: false,
    reset: { inProgress: true, completedAt: null, lastError: null } })).toBe(false);
  expect(isNativeCrashProofReady({ hubMesh: { ok: true }, systemOk: true,
    reset: { inProgress: false, completedAt: null, lastError: null } })).toBe(false);
  expect(isNativeCrashProofReady({ hubMesh: { ok: true }, systemOk: true,
    reset: { inProgress: false, completedAt: 1000, lastError: 'bootstrap failed' } })).toBe(false);
  expect(isNativeCrashProofReady({ hubMesh: { ok: true }, systemOk: true,
    reset: { inProgress: false, completedAt: 1000, lastError: null } })).toBe(true);
});
