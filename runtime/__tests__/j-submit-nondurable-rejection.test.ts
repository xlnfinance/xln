import { describe, expect, test } from 'bun:test';

import { splitJOutboxForDurableSubmit } from '../machine/j-submit-state';
import type { JTx } from '../types';

const input = (jTx: JTx) => [{ jurisdictionName: 'Testnet', jTxs: [jTx] }];

describe('J submit durable-lane admission', () => {
  test('rejects direct mint before an R-frame can commit it', () => {
    expect(() => splitJOutboxForDurableSubmit(input({
      type: 'mint',
      entityId: `0x${'11'.repeat(32)}`,
      data: { entityId: `0x${'11'.repeat(32)}`, tokenId: 1, amount: 1n },
      timestamp: 1,
    }))).toThrow('J_SUBMIT_NON_DURABLE_COMMAND_FORBIDDEN:mint');
  });

  test('rejects direct debt enforcement before an R-frame can commit it', () => {
    expect(() => splitJOutboxForDurableSubmit(input({
      type: 'debtEnforcement',
      entityId: `0x${'22'.repeat(32)}`,
      data: { tokenId: 1, maxIterations: 10n },
      timestamp: 1,
    }))).toThrow('J_SUBMIT_NON_DURABLE_COMMAND_FORBIDDEN:debtEnforcement');
  });
});
