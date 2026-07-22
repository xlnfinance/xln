import { LIMITS } from '../constants';
import { encodeBuffer } from '../storage/codec';
import type { AccountMachine, AccountTx } from '../types';

type BoundedCollection = 'deltas' | 'locks' | 'swapOffers';

const collectionsChangedBy = (tx: AccountTx): readonly BoundedCollection[] => {
  if (tx.type === 'htlc_lock' || tx.type === 'htlc_resolve') return ['deltas', 'locks'];
  if (tx.type === 'swap_offer' || tx.type === 'swap_resolve' || tx.type === 'cross_swap_fill_ack') {
    return ['deltas', 'swapOffers'];
  }
  if (tx.type === 'rebalance_policy' || tx.type === 'reopen_disputed' || tx.type === 'account_frame') return [];
  return ['deltas'];
};

export const assertChangedAccountCollectionsFitStorage = (
  account: AccountMachine,
  tx: AccountTx,
): void => {
  for (const field of collectionsChangedBy(tx)) {
    const bytes = encodeBuffer(account[field]).byteLength;
    if (bytes >= LIMITS.MAX_STORAGE_VALUE_BYTES) {
      const composition = field === 'swapOffers'
        ? Array.from(account.swapOffers.values()).reduce(
            (counts, offer) => {
              if (offer.crossJurisdiction) counts.crossJ += 1;
              else counts.sameJ += 1;
              return counts;
            },
            { sameJ: 0, crossJ: 0 },
          )
        : null;
      throw new Error(
        `ACCOUNT_COLLECTION_STORAGE_LIMIT_EXCEEDED:field=${field}:bytes=${bytes}:` +
        `maxExclusive=${LIMITS.MAX_STORAGE_VALUE_BYTES}:entries=${account[field].size}` +
        (composition ? `:sameJ=${composition.sameJ}:crossJ=${composition.crossJ}` : ''),
      );
    }
  }
};
