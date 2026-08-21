import { describe, expect, test } from 'bun:test';
import type { AccountReplica } from '../types/account';
import { resolveStoredDisputeStartNonce } from '../entity/tx/handlers/dispute/start-evidence';

const proofBodyHash = `0x${'11'.repeat(32)}`;

const sealedAccount = (overrides: Partial<AccountReplica> = {}): AccountReplica => ({
  counterpartyDisputeProofBodyHash: proofBodyHash,
  counterpartyDisputeProofNonce: 2,
  ...overrides,
} as AccountReplica);

describe('dispute start evidence identity', () => {
  test('uses the nonce bound to the peer Hanko when a local seal reused the ProofBody at a newer nonce', () => {
    expect(resolveStoredDisputeStartNonce(sealedAccount(), proofBodyHash)).toEqual({
      signedNonce: 2,
      nonceSource: 'counterpartySeal',
    });
  });

  test('rejects a ProofBody that is not the one bound to the peer seal', () => {
    const otherHash = `0x${'22'.repeat(32)}`;
    expect(() => resolveStoredDisputeStartNonce(sealedAccount(), otherHash)).toThrow(
      'DISPUTE_START_SEAL_PROOFBODY_MISMATCH',
    );
  });

  test('rejects a peer seal without its exact positive nonce', () => {
    expect(() => resolveStoredDisputeStartNonce(
      sealedAccount({ counterpartyDisputeProofNonce: undefined }),
      proofBodyHash,
    )).toThrow('DISPUTE_START_SEAL_NONCE_INVALID');
  });
});
