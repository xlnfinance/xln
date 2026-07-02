import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import {
  buildPendingBatchEntityInput,
  enqueuePendingBatchAction,
} from '../../frontend/src/lib/components/Entity/pending-batch-actions';

describe('pending batch action helpers', () => {
  test('pending batch actions do not require embedded Env', () => {
    const source = readFileSync('frontend/src/lib/components/Entity/pending-batch-actions.ts', 'utf8');
    expect(source).not.toContain('EnvSnapshot');
    expect(source).not.toContain('requireRuntimeEnv');
    expect(source).not.toContain('activeEnv');
  });

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

  test('fails fast before enqueueing when entity, signer, or live mode is missing', async () => {
    expect(() => buildPendingBatchEntityInput('', 'signer-1', 'broadcast')).toThrow('Active entity missing');
    expect(() => buildPendingBatchEntityInput('entity-1', '', 'broadcast')).toThrow('Signer missing');

    await expect(enqueuePendingBatchAction({
      activeIsLive: false,
      entityId: 'entity-1',
      action: 'broadcast',
      context: 'test-broadcast',
      resolveEntitySigner: () => {
        throw new Error('resolveEntitySigner should not run before live-mode validation');
      },
      submitEntityInputs: async () => {
        throw new Error('submitEntityInputs should not run before live-mode validation');
      },
    })).rejects.toThrow('Batch actions require LIVE mode');

    const submitted = await enqueuePendingBatchAction({
      activeIsLive: true,
      entityId: 'entity-1',
      action: 'broadcast',
      context: 'test-broadcast',
      resolveEntitySigner: () => 'signer-1',
      submitEntityInputs: async (env) => env,
    });
    expect(submitted).toBeUndefined();
  });
});
