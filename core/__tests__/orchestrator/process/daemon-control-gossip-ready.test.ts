import { afterEach, expect, test } from 'bun:test';

import { DaemonControlClient } from '../../../orchestrator/daemon-control';
import { deserializeTaggedJson, safeStringify } from '../../../protocol/serialization';

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

test('chunks large gossip readiness barriers below the control body cap', async () => {
  const targets = Array.from({ length: 2_501 }, (_, index) => ({
    entityId: `0x${index.toString(16).padStart(64, '0')}`,
    runtimeId: `0x${index.toString(16).padStart(40, '0')}`,
  }));
  const batchSizes: number[] = [];
  globalThis.fetch = async (_input, init) => {
    const body = deserializeTaggedJson(String(init?.body)) as { targets: typeof targets };
    batchSizes.push(body.targets.length);
    return new Response(safeStringify({
      ok: true,
      ready: false,
      missing: [body.targets[0]!.entityId],
    }), { status: 200, headers: { 'content-type': 'application/json' } });
  };

  const result = await new DaemonControlClient({ baseUrl: 'http://control.test' })
    .gossipProfilesSendReady(targets);

  expect(batchSizes).toEqual([1_000, 1_000, 501]);
  expect(result).toEqual({
    ready: false,
    missing: [targets[0]!.entityId, targets[1_000]!.entityId, targets[2_000]!.entityId],
  });
});
