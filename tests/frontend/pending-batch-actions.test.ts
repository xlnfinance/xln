import { describe, expect, test } from 'bun:test';
import type { Env } from '@xln/runtime/xln-api';

import {
  buildPendingBatchEntityInput,
  enqueuePendingBatchAction,
} from '../../frontend/src/lib/components/Entity/pending-batch-actions';

const runtimeEnv = {
  eReplicas: new Map(),
  jReplicas: new Map(),
  history: [],
} as unknown as Env;

describe('pending batch action helpers', () => {
  test('builds routed entity inputs for pending batch actions', () => {
    expect(buildPendingBatchEntityInput(' entity-1 ', ' signer-1 ', 'broadcast')).toEqual({
      entityId: 'entity-1',
      signerId: 'signer-1',
      entityTxs: [{ type: 'j_broadcast', data: {} }],
    });

    expect(buildPendingBatchEntityInput('entity-1', 'signer-1', 'clear').entityTxs).toEqual([{
      type: 'j_clear_batch',
      data: { reason: 'global-batch-bar-clear' },
    }]);

    expect(buildPendingBatchEntityInput('entity-1', 'signer-1', 'rebroadcast').entityTxs).toEqual([{
      type: 'j_rebroadcast',
      data: { gasBumpBps: 1000 },
    }]);
  });

  test('fails fast before enqueueing when entity, signer, live mode, or env is missing', async () => {
    expect(() => buildPendingBatchEntityInput('', 'signer-1', 'broadcast')).toThrow('Active entity missing');
    expect(() => buildPendingBatchEntityInput('entity-1', '', 'broadcast')).toThrow('Signer missing');

    await expect(enqueuePendingBatchAction({
      activeEnv: runtimeEnv,
      activeIsLive: false,
      entityId: 'entity-1',
      action: 'broadcast',
      context: 'test-broadcast',
      resolveEntitySigner: () => {
        throw new Error('resolveEntitySigner should not run before live-mode validation');
      },
      enqueueEntityInputs: async () => {
        throw new Error('enqueueEntityInputs should not run before live-mode validation');
      },
    })).rejects.toThrow('Batch actions require LIVE mode');

    await expect(enqueuePendingBatchAction({
      activeEnv: null,
      activeIsLive: true,
      entityId: 'entity-1',
      action: 'broadcast',
      context: 'test-broadcast',
      resolveEntitySigner: () => 'signer-1',
      enqueueEntityInputs: async (env) => env,
    })).rejects.toThrow('test-broadcast requires live runtime environment');
  });
});
