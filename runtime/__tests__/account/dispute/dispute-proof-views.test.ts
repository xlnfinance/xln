import { describe, expect, test } from 'bun:test';

import type { AccountReplica } from '../../../types/account';
import {
  getDisputeProofTupleError,
  hasCounterpartyCertifiedDisputeProof,
  hasLocalCertifiedDisputeProof,
  hasLocalUnsignedDisputeProof,
} from '../../../account/consensus/dispute/proof-views';

const account = (): AccountReplica => ({
  entityId: 'left',
  counterpartyId: 'right',
} as AccountReplica);

describe('FinTS dispute proof views', () => {
  test('distinguishes unsigned and certified local proof tuples', () => {
    const candidate: AccountReplica = Object.assign(account(), {
      currentDisputeHash: 'hash',
      currentDisputeProofBodyHash: 'body',
      currentDisputeProofNonce: 1,
      currentDisputeProofProposerIsLeft: true,
    });
    expect(hasLocalUnsignedDisputeProof(candidate)).toBe(true);
    candidate.currentDisputeProofHanko = 'hanko';
    expect(hasLocalCertifiedDisputeProof(candidate)).toBe(true);
  });

  test('requires the full counterparty certified tuple', () => {
    const candidate: AccountReplica = Object.assign(account(), {
      counterpartyDisputeHash: 'hash',
      counterpartyDisputeProofBodyHash: 'body',
      counterpartyDisputeProofNonce: 1,
      counterpartyDisputeProofProposerIsLeft: false,
      counterpartyDisputeProofHanko: 'hanko',
    });
    expect(hasCounterpartyCertifiedDisputeProof(candidate)).toBe(true);
    expect(getDisputeProofTupleError(candidate)).toBeNull();
  });

  test('rejects partial durable proof tuples', () => {
    const candidate: AccountReplica = Object.assign(account(), {
      counterpartyDisputeHash: 'hash',
    });
    expect(getDisputeProofTupleError(candidate)).toBe('COUNTERPARTY_DISPUTE_PROOF_PARTIAL');
  });
});
