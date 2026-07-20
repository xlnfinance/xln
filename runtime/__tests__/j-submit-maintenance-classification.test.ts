import { describe, expect, test } from 'bun:test';

import { splitJOutboxForDurableSubmit } from '../machine/j-submit-state';
import type { JTx } from '../types';

const input = (jTx: JTx) => [{ jurisdictionName: 'Testnet', jTxs: [jTx] }];

describe('J submit maintenance lane', () => {
  test('keeps dev mint outside the durable financial attempt FSM', () => {
    const split = splitJOutboxForDurableSubmit(input({
      type: 'mint',
      entityId: `0x${'11'.repeat(32)}`,
      data: { entityId: `0x${'11'.repeat(32)}`, tokenId: 1, amount: 1n },
      timestamp: 1,
    }));
    expect(split.maintenance).toHaveLength(1);
    expect(split.durable).toEqual([]);
    expect(split.retries).toEqual([]);
  });

  test('keeps permissionless monotonic debt progress outside financial attempts', () => {
    const split = splitJOutboxForDurableSubmit(input({
      type: 'debtEnforcement',
      entityId: `0x${'22'.repeat(32)}`,
      data: { tokenId: 1, maxIterations: 10n },
      timestamp: 1,
    }));
    expect(split.maintenance[0]?.jTxs[0]?.type).toBe('debtEnforcement');
    expect(split.durable).toEqual([]);
    expect(split.retries).toEqual([]);
  });
});
