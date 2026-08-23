import { describe, expect, test } from 'bun:test';

import { removeCommittedTxsFromMempool, txFingerprint } from '../../../protocol/state/tx-multiset';

const accountInput = (accountTxs: unknown[]) => ({
  type: 'accountInput',
  data: {
    kind: 'frame',
    fromEntityId: `0x${'11'.repeat(32)}`,
    toEntityId: `0x${'22'.repeat(32)}`,
    proposal: {
      frame: {
        height: 7,
        stateHash: `0x${'ab'.repeat(32)}`,
        prevFrameHash: `0x${'cd'.repeat(32)}`,
        accountStateRoot: `0x${'ef'.repeat(32)}`,
        timestamp: 1_000,
        jHeight: 3,
        byLeft: true,
        accountTxs,
        deltas: [{ tokenId: 1, offdelta: 5n }],
      },
      frameHanko: `0x${'99'.repeat(65)}`,
    },
  },
});

describe('account input mempool identity', () => {
  test('two envelopes claiming one stateHash over different bodies never share a fingerprint', () => {
    const valid = accountInput([{ type: 'direct_payment', data: { tokenId: 1, amount: 5n, memo: 'a' } }]);
    const poison = accountInput([{ type: 'direct_payment', data: { tokenId: 1, amount: 5n, memo: 'b' } }]);
    expect(txFingerprint(valid)).not.toBe(txFingerprint(poison));
    expect(txFingerprint(valid)).toBe(txFingerprint(structuredClone(valid)));
  });

  test('committing a clone of the valid input removes the valid input, not the poison', () => {
    const valid = accountInput([{ type: 'direct_payment', data: { tokenId: 1, amount: 5n, memo: 'a' } }]);
    const poison = accountInput([{ type: 'direct_payment', data: { tokenId: 1, amount: 5n, memo: 'b' } }]);
    const remaining = removeCommittedTxsFromMempool([poison, valid], [structuredClone(valid)]);
    expect(remaining).toEqual([poison]);
  });
});
