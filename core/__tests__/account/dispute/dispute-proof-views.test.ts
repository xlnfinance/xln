import { describe, expect, test } from 'bun:test';

import type { AccountReplica } from '../../../types/account';
import { hasLocalCertifiedDisputeProof } from '../../../account/consensus/dispute/proof-views';

const account = (): AccountReplica => ({
  entityId: 'left',
  counterpartyId: 'right',
} as AccountReplica);

describe('FinTS dispute proof views', () => {
  test('a local proof tuple is certified only once its Hanko is present', () => {
    const candidate: AccountReplica = Object.assign(account(), {
      currentDisputeHash: 'hash',
      currentDisputeProofBodyHash: 'body',
      currentDisputeProofNonce: 1,
      currentDisputeProofProposerIsLeft: true,
    });
    expect(hasLocalCertifiedDisputeProof(candidate)).toBe(false);
    candidate.currentDisputeProofHanko = 'hanko';
    expect(hasLocalCertifiedDisputeProof(candidate)).toBe(true);
  });
});
