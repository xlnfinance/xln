import { describe, expect, test } from 'bun:test';

import type { JBatch } from '../../runtime/j-batch';
import {
  buildPendingBatchActionTxs,
  buildPendingBatchState,
  canBroadcastPendingBatch,
  countBatchOps,
} from '../../frontend/src/lib/components/Entity/pending-batch-preview';

const batch = (input: Partial<JBatch>): JBatch => ({
  flashloans: [],
  reserveToCollateral: [],
  collateralToReserve: [],
  settlements: [],
  reserveToReserve: [],
  disputeStarts: [],
  disputeFinalizations: [],
  externalTokenToReserve: [],
  reserveToExternalToken: [],
  revealSecrets: [],
  ...input,
} as JBatch);

describe('pending batch helpers', () => {
  test('counts every visible batch operation bucket', () => {
    expect(countBatchOps(batch({
      reserveToCollateral: [{ tokenId: 1, pairs: [] }] as any,
      collateralToReserve: [{ tokenId: 1, amount: 1n }] as any,
      settlements: [{}] as any,
      reserveToReserve: [{ tokenId: 1, amount: 1n }] as any,
      disputeStarts: [{}] as any,
      disputeFinalizations: [{}] as any,
      externalTokenToReserve: [{}] as any,
      reserveToExternalToken: [{}] as any,
      revealSecrets: [{}] as any,
    }))).toBe(9);
  });

  test('derives draft-first state and preview batch', () => {
    const draft = batch({ reserveToReserve: [{}] as any });
    const sent = batch({ reserveToExternalToken: [{}, {}] as any });

    expect(buildPendingBatchState({ batch: draft, sentBatch: { batch: sent } })).toEqual({
      draftCount: 1,
      sentCount: 2,
      count: 1,
      mode: 'draft',
      hasDraftBatch: true,
      hasSentBatch: true,
      previewBatch: draft,
    });
    expect(buildPendingBatchState({ batch: null, sentBatch: { batch: sent } })).toMatchObject({
      draftCount: 0,
      sentCount: 2,
      count: 2,
      mode: 'sent',
      hasDraftBatch: false,
      hasSentBatch: true,
      previewBatch: sent,
    });
    expect(buildPendingBatchState(null)).toMatchObject({
      count: 0,
      mode: null,
      hasDraftBatch: false,
      hasSentBatch: false,
      previewBatch: null,
    });
  });

  test('allows broadcast only for issue-free draft without sent batch', () => {
    expect(canBroadcastPendingBatch({ hasDraftBatch: true, hasSentBatch: false }, null)).toBe(true);
    expect(canBroadcastPendingBatch({ hasDraftBatch: false, hasSentBatch: false }, null)).toBe(false);
    expect(canBroadcastPendingBatch({ hasDraftBatch: true, hasSentBatch: true }, null)).toBe(false);
    expect(canBroadcastPendingBatch({ hasDraftBatch: true, hasSentBatch: false }, { issue: true })).toBe(false);
  });

  test('builds exact global pending-batch action txs', () => {
    expect(buildPendingBatchActionTxs('clear')).toEqual([
      { type: 'j_clear_batch', data: { reason: 'global-batch-bar-clear' } },
    ]);
    expect(buildPendingBatchActionTxs('broadcast')).toEqual([
      { type: 'j_broadcast', data: {} },
    ]);
    expect(buildPendingBatchActionTxs('rebroadcast')).toEqual([
      { type: 'j_rebroadcast', data: { gasBumpBps: 1000 } },
    ]);
  });
});
