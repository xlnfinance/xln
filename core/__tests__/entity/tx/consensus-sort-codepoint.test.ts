import { describe, expect, test } from 'bun:test';

import { mergeJEventClaimOps } from '../../../entity/tx/j-events-account';
import type { JEventAccountTx } from '../../../entity/tx/j-events-types';

const claim = (accountId: string, jBlockHash: string): JEventAccountTx => ({
  accountId,
  tx: {
    type: 'j_event_claim',
    data: { jHeight: 1, jBlockHash, events: [] },
  },
});

describe('consensus claim order', () => {
  test('orders J-event claims by codepoint, not localeCompare', () => {
    const ops = [claim('é-account', '0xbb'), claim('z-account', '0xaa')];
    mergeJEventClaimOps(ops);
    expect(ops.map(op => op.accountId)).toEqual(['z-account', 'é-account']);
  });
});
