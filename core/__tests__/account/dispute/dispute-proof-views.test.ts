import { describe, expect, test } from 'bun:test';

import type { AccountReplica } from '../../../types/account';
import { hasLocalCertifiedDisputeProof, reuseCertifiedDisputeHanko } from '../../../account/consensus/dispute/proof-views';

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

test('reused dispute witnesses bind body, side and a nonce beyond on-chain state', () => {
  const proof: AccountReplica = Object.assign(account(), { currentDisputeHash: 'hash', currentDisputeProofBodyHash: 'BODY',
    currentDisputeProofNonce: 2, currentDisputeProofProposerIsLeft: true, currentDisputeProofHanko: 'hanko' });
  expect(reuseCertifiedDisputeHanko(proof, 'body', true, 1)?.hanko).toBe('hanko');
  expect(reuseCertifiedDisputeHanko(proof, 'other', true, 1)).toBeUndefined();
  expect(reuseCertifiedDisputeHanko(proof, 'body', false, 1)).toBeUndefined();
  expect(reuseCertifiedDisputeHanko(proof, 'body', true, 2)).toBeUndefined();
  delete proof.currentDisputeProofHanko;
  expect(reuseCertifiedDisputeHanko(proof, 'body', true, 1)).toBeUndefined();
});
