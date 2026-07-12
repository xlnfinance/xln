import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { detachRuntimeP2P } from '../machine/p2p-lifecycle';
import type { Env } from '../types';

test('runtime p2p lifecycle diagnostics use structured logging', () => {
  const source = readFileSync(join(process.cwd(), 'runtime/machine/p2p-lifecycle.ts'), 'utf8');

  expect(source).toContain("const p2pLifecycleLog = createStructuredLogger('p2p.lifecycle');");
  expect(source).toContain("p2pLifecycleLog.warn('detach.close_failed'");
  expect(source).not.toContain('console.');
  expect(source).not.toContain('Failed to close P2P during runtime detach');
});

test('detachRuntimeP2P closes p2p and clears runtime state', () => {
  let closed = 0;
  const env = {
    runtimeState: {
      p2p: {
        close: () => {
          closed += 1;
        },
      },
    },
  } as unknown as Env;

  detachRuntimeP2P(env, {
    ensureRuntimeState: (targetEnv) => {
      targetEnv.runtimeState ??= {};
      return targetEnv.runtimeState;
    },
    notifyEnvChange: () => {},
    handleInboundP2PEntityInput: () => {},
  });

  expect(closed).toBe(1);
  expect(env.runtimeState?.p2p).toBeNull();
});
